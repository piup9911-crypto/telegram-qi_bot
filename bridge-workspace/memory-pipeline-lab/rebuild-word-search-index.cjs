const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { applyMigrations } = require('./memory-v1-migrate.cjs');
const { createChineseWordSegmenter, dictionaryTerms } = require('./chinese-word-segmenter.cjs');

const labDir = __dirname;
const defaultDbPath = path.join(labDir, 'memory-schema-v2-complete.sqlite');
const defaultRawCachePath = path.join(labDir, 'raw-user-embeddings.json');

function parseArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function textValues(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(textValues);
  if (value && typeof value === 'object') return Object.values(value).flatMap(textValues);
  return [];
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function sourceRows(db, rawCachePath) {
  const cards = db.prepare(`
    SELECT c.*,group_concat(s.evidence_quote,' ') AS evidence
    FROM memory_cards c LEFT JOIN memory_sources s ON s.memory_card_id=c.id
    WHERE c.status='active' GROUP BY c.id ORDER BY c.memory_key
  `).all();
  const summaries = db.prepare('SELECT * FROM event_summaries ORDER BY conversation_id,start_message_index').all();
  const occurrences = db.prepare(`
    SELECT e.*,s.topic AS summary_topic,s.gist AS summary_gist
    FROM event_occurrences e LEFT JOIN event_summaries s ON s.id=e.summary_id
    ORDER BY e.occurred_at,e.id
  `).all();
  const timelines = db.prepare('SELECT * FROM fact_timelines ORDER BY fact_key').all();
  const factEvents = db.prepare(`
    SELECT timeline_id,value_text,content,valid_at,observed_at,event_kind
    FROM fact_events ORDER BY timeline_id,COALESCE(valid_at,observed_at),id
  `).all();
  const factEventsByTimeline = new Map();
  for (const row of factEvents) {
    const rows = factEventsByTimeline.get(row.timeline_id) || [];
    rows.push(row);
    factEventsByTimeline.set(row.timeline_id, rows);
  }
  const rawCache = JSON.parse(fs.readFileSync(rawCachePath, 'utf8'));
  const rawIds = new Set(rawCache.ids || []);
  const raw = db.prepare(`
    SELECT id,text,local_date FROM raw_messages
    WHERE speaker='user' AND conversation_id IN ('telegram_archive_20260509','telegram_active')
    ORDER BY timestamp,message_index
  `).all().filter((row) => rawIds.has(row.id));
  return { cards, summaries, occurrences, timelines, factEventsByTimeline, raw };
}

function collectDomainTerms(rows) {
  const values = [];
  for (const row of rows.cards) values.push(row.title,row.topic,row.domain,row.memory_key);
  for (const row of rows.summaries) values.push(row.topic,row.topic_key,...textValues(parseArray(row.retrieval_terms_json)));
  for (const row of rows.occurrences) values.push(row.event_label,row.event_key,...textValues(parseArray(row.aliases_json)));
  for (const row of rows.timelines) values.push(row.topic,row.fact_key,row.predicate_key,row.domain);
  return dictionaryTerms(values);
}

function rebuildWordSearchIndex(dbOrPath = defaultDbPath, options = {}) {
  const ownsDb = typeof dbOrPath === 'string';
  const dbPath = ownsDb ? dbOrPath : options.dbPath || defaultDbPath;
  if (ownsDb) applyMigrations(dbPath);
  const db = ownsDb ? new DatabaseSync(dbPath) : dbOrPath;
  const rawCachePath = options.rawCachePath || defaultRawCachePath;
  const rows = sourceRows(db, rawCachePath);
  const segmenter = createChineseWordSegmenter(collectDomainTerms(rows));
  const documents = [];

  function add(targetId, targetType, subjectKey, localDate, text, aliases = []) {
    const indexed = segmenter.indexDocument(text, aliases);
    const wordsText = indexed.words.join(' ');
    const aliasesText = indexed.aliases.join(' ');
    documents.push({
      targetId,targetType,subjectKey:subjectKey || null,localDate:localDate || null,
      wordsText,aliasesText,
      sourceHash:sha256(`${text}\n${aliases.join('\n')}`)
    });
  }

  for (const row of rows.cards) {
    add(`card:${row.memory_key}`,'card',row.subject_key,null,
      [row.memory_key,row.title,row.content,row.domain,row.topic,row.evidence].filter(Boolean).join(' '),
      [row.memory_key,row.title,row.topic,row.domain]);
  }
  for (const row of rows.summaries) {
    const retrieval = textValues(parseArray(row.retrieval_terms_json));
    add(`summary:${row.id}`,'summary',null,null,
      [row.topic_key,row.topic,row.gist,row.user_confirmed_json,retrieval.join(' ')].join(' '),
      [row.topic,row.topic_key,...retrieval]);
    for (const [index,goal] of parseArray(row.user_goals_json).entries()) {
      if (!goal || !String(goal.text || '').trim()) continue;
      add(`goal:${row.id}:${index}`,'goal','user',null,
        [row.topic,goal.text,row.gist].filter(Boolean).join(' '),[row.topic,...retrieval]);
    }
  }
  for (const row of rows.occurrences) {
    const aliases = textValues(parseArray(row.aliases_json));
    add(`event:${row.id}`,'event',row.subject_key,row.local_date,
      [row.event_key,row.event_label,row.event_text,aliases.join(' '),row.summary_topic,row.summary_gist].filter(Boolean).join(' '),
      [row.event_key,row.event_label,...aliases]);
  }
  for (const row of rows.timelines) {
    const events = rows.factEventsByTimeline.get(row.id) || [];
    add(`fact:${row.fact_key}`,'fact',row.subject_key,null,
      [row.fact_key,row.subject_key,row.predicate_key,row.domain,row.topic,
        ...events.flatMap((event) => [event.value_text,event.content])].filter(Boolean).join(' '),
      [row.fact_key,row.predicate_key,row.topic,row.domain]);
  }
  for (const row of rows.raw) add(row.id,'raw','user',row.local_date,row.text,[]);

  const insert = db.prepare(`
    INSERT INTO memory_search_documents(
      target_id,target_type,subject_key,local_date,words_text,aliases_text,source_hash,tokenizer_version,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?)
  `);
  const now = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DELETE FROM memory_search_documents');
    for (const document of documents) {
      insert.run(document.targetId,document.targetType,document.subjectKey,document.localDate,
        document.wordsText,document.aliasesText,document.sourceHash,segmenter.engineVersion,now);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    if (ownsDb) db.close();
    throw error;
  }

  const counts = db.prepare(`
    SELECT target_type,count(*) AS count FROM memory_search_documents GROUP BY target_type ORDER BY target_type
  `).all();
  const result = {
    database: dbPath,
    tokenizer_version: segmenter.engineVersion,
    custom_dictionary_terms: segmenter.customTerms.length,
    documents: documents.length,
    fts_rows: Number(db.prepare('SELECT count(*) AS n FROM memory_search_terms_fts').get().n),
    counts
  };
  if (ownsDb) db.close();
  return result;
}

if (require.main === module) {
  process.stdout.write(`${JSON.stringify(rebuildWordSearchIndex(process.argv[2] || defaultDbPath), null, 2)}\n`);
}

module.exports = { rebuildWordSearchIndex, defaultDbPath, defaultRawCachePath };
