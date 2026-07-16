const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { embed } = require('./hybrid-retriever.cjs');
const { classifyRetrievalText } = require('./retrieval-text-quality.cjs');

const dbPath = path.resolve(process.argv[2] || path.join(__dirname, 'memory-schema-v2-complete.sqlite'));
const cachePath = path.resolve(process.argv[3] || path.join(__dirname, 'raw-user-embeddings.json'));

function hash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

async function embedBatches(texts, batchSize = 64) {
  const vectors = [];
  for (let start = 0; start < texts.length; start += batchSize) {
    vectors.push(...await embed(texts.slice(start, start + batchSize)));
  }
  return vectors;
}

function atomicJson(filePath, value) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, 'utf8');
  fs.renameSync(temporary, filePath);
}

async function main() {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const allRows = db.prepare(`
    SELECT id,text,text_hash FROM raw_messages
    WHERE speaker='user'
      AND conversation_id IN ('telegram_archive_20260509','telegram_active')
      AND COALESCE(memory_review_reason, '') NOT IN ('contains_secret_or_credential','embedded_prompt_or_transcript_artifact')
    ORDER BY conversation_id,source_message_index
  `).all();
  db.close();
  const excluded = [];
  const rows = [];
  for (const row of allRows) {
    const quality = classifyRetrievalText(row.text);
    if (quality.eligible) rows.push(row);
    else excluded.push({ id: row.id, reason: quality.reason });
  }
  const oldCache = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, 'utf8')) : { ids: [], embeddings: [] };
  const byId = new Map((oldCache.ids || []).map((id, index) => [id, oldCache.embeddings?.[index]]));
  const missing = rows.filter((row) => !Array.isArray(byId.get(row.id)));
  if (missing.length) {
    const vectors = await embedBatches(missing.map((row) => row.text.slice(0, 3000)));
    missing.forEach((row, index) => byId.set(row.id, vectors[index]));
  }
  const output = {
    fingerprint: hash(rows.map((row) => `${row.id}:${row.text_hash}`).join('|')),
    model: 'bge-m3',
    quality_policy: 'retrieval-text-quality-v1',
    excluded_low_information: excluded.length,
    excluded_reasons: Object.fromEntries([...new Set(excluded.map((item) => item.reason))]
      .map((reason) => [reason, excluded.filter((item) => item.reason === reason).length])),
    ids: rows.map((row) => row.id),
    embeddings: rows.map((row) => byId.get(row.id))
  };
  if (output.embeddings.some((vector) => !Array.isArray(vector))) throw new Error('Vector cache contains a missing embedding');
  atomicJson(cachePath, output);
  process.stdout.write(`${JSON.stringify({
    database: dbPath,
    cache: cachePath,
    source_user_messages: allRows.length,
    indexed_messages: rows.length,
    excluded_low_information: excluded.length,
    excluded_reasons: output.excluded_reasons,
    reused_vectors: rows.length - missing.length,
    embedded_new_vectors: missing.length,
    excluded_examples: excluded.slice(0, 12).map((item) => item.id)
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
