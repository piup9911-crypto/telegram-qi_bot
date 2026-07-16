const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { createChineseWordSegmenter } = require('./chinese-word-segmenter.cjs');

const dbPath = process.argv[2] || path.join(__dirname, 'memory-schema-v2-complete.sqlite');
const outputPath = path.join(__dirname, 'word-search-index-validation.json');
const db = new DatabaseSync(dbPath, { readOnly: true });

const version = Number(db.prepare('PRAGMA user_version').get().user_version);
const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
const documents = Number(db.prepare('SELECT count(*) AS n FROM memory_search_documents').get().n);
const ftsRows = Number(db.prepare('SELECT count(*) AS n FROM memory_search_terms_fts').get().n);
const counts = db.prepare(`
  SELECT target_type,count(*) AS count FROM memory_search_documents GROUP BY target_type ORDER BY target_type
`).all();
const duplicateTargets = db.prepare(`
  SELECT target_id,count(*) AS count FROM memory_search_documents GROUP BY target_id HAVING count(*)>1
`).all();
const unsafeRaw = db.prepare(`
  SELECT d.target_id,m.memory_review_reason
  FROM memory_search_documents d JOIN raw_messages m ON m.id=d.target_id
  WHERE d.target_type='raw' AND m.memory_review_reason IN (
    'contains_secret_or_credential','embedded_prompt_or_transcript_artifact'
  )
`).all();
const versions = db.prepare(`
  SELECT tokenizer_version,count(*) AS count FROM memory_search_documents GROUP BY tokenizer_version
`).all();

const segmenter = createChineseWordSegmenter(['微信','Server酱','Sidecar','Agent Mail']);
const tokenCases = {
  wechat_push: segmenter.queryTerms('微信那个推送工具'),
  short_facts: segmenter.queryTerms('月经、排班、邮箱和通勤')
};
const tokenChecks = tokenCases.wechat_push.includes('微信') && tokenCases.wechat_push.includes('推送')
  && ['月经','排班','邮箱','通勤'].every((term) => tokenCases.short_facts.includes(term));

const expected = { card: 14, event: 12, fact: 9, goal: 46, raw: 1322, summary: 57 };
const actual = Object.fromEntries(counts.map((row) => [row.target_type,Number(row.count)]));
const countsMatch = Object.entries(expected).every(([type,count]) => actual[type] === count);

const result = {
  generated_at: new Date().toISOString(),
  database: dbPath,
  schema_version: version,
  integrity_check: integrity,
  foreign_key_errors: foreignKeys,
  documents,
  fts_rows: ftsRows,
  counts,
  tokenizer_versions: versions,
  duplicate_targets: duplicateTargets,
  unsafe_raw_documents: unsafeRaw,
  token_cases: tokenCases,
  passed: version >= 5 && integrity === 'ok' && foreignKeys.length === 0 && documents === ftsRows
    && countsMatch && duplicateTargets.length === 0 && unsafeRaw.length === 0 && tokenChecks
};

db.close();
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.passed) process.exitCode = 1;
