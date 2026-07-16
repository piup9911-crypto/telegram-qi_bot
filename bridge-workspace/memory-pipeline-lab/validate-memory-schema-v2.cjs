const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const labDir = __dirname;
const defaultDbPath = path.join(labDir, 'memory-schema-v2-complete.sqlite');
const sourceDbPath = path.join(labDir, 'memory-graphiti-temporal-lab.sqlite');
const outputPath = path.join(labDir, 'schema-v2-validation.json');

const requiredColumns = {
  conversations: ['id', 'source_kind', 'started_at', 'ended_at', 'timezone_name'],
  raw_messages: ['id', 'conversation_id', 'speaker', 'text', 'timestamp', 'local_date', 'text_hash'],
  event_summaries: ['id', 'topic_key', 'summary_mode', 'gist', 'memory_action', 'memory_processed_at', 'memory_policy_version'],
  memory_cards: ['id', 'subject_key', 'memory_key', 'memory_type', 'domain', 'status', 'source_identity', 'sensitivity', 'recall_scope'],
  memory_sources: ['id', 'memory_card_id', 'raw_message_id', 'relation', 'evidence_quote', 'added_at'],
  fact_timelines: ['id', 'fact_key', 'subject_key', 'domain', 'predicate_key', 'current_event_id', 'sensitivity', 'recall_scope'],
  fact_events: ['id', 'timeline_id', 'value_text', 'valid_at', 'invalid_at', 'observed_at', 'recorded_at', 'source_message_ids_json', 'evidence_quotes_json', 'correction_of_event_id'],
  memory_processing_jobs: [
    'id', 'job_kind', 'trigger_kind', 'status', 'input_message_ids_json',
    'retrieval_trace_json', 'attempt_count', 'next_attempt_at',
    'lease_expires_at', 'last_error_code', 'input_hash', 'output_json',
    'validation_json', 'write_result_json', 'processor_version', 'committed_at'
  ]
};

const businessTables = ['conversations', 'raw_messages', 'event_summaries', 'fact_timelines', 'memory_cards', 'memory_sources', 'fact_events'];

function columns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
}

function rowCounts(db, tables) {
  return Object.fromEntries(tables.map((table) => [table, Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n)]));
}

function testJobGuards(db) {
  const conversation = db.prepare('SELECT id FROM conversations ORDER BY id LIMIT 1').get();
  if (!conversation) return { skipped: true, reason: 'no_conversation' };
  const now = '2026-07-13T20:30:00+08:00';
  const retryAt = '2026-07-20T20:30:00+08:00';
  let duplicateBlocked = false;
  db.exec('SAVEPOINT job_guard_test');
  try {
    const insert = db.prepare(`
      INSERT INTO memory_processing_jobs (
        id, conversation_id, job_kind, trigger_kind, status, priority,
        input_message_ids_json, retrieval_trace_json, provider, model,
        policy_version, attempt_count, max_attempts, next_attempt_at,
        last_error_code, last_error_message, created_at, updated_at
      ) VALUES (?, ?, 'recall_consolidate', 'recall_memory', 'retry_wait', 50,
                '[]', '{"reused":true}', 'antigravity', 'gemini-flash',
                'schema-v2-test', 1, 3, ?, 'RESOURCE_EXHAUSTED', 'quota reached', ?, ?)
    `);
    insert.run('schema_v2_guard_job_1', conversation.id, retryAt, now, now);
    const saved = db.prepare("SELECT status,next_attempt_at,last_error_code,json_extract(retrieval_trace_json,'$.reused') AS reused FROM memory_processing_jobs WHERE id='schema_v2_guard_job_1'").get();
    try {
      insert.run('schema_v2_guard_job_2', conversation.id, retryAt, now, now);
    } catch (error) {
      duplicateBlocked = String(error.message).includes('UNIQUE constraint failed');
    }
    return {
      skipped: false,
      retry_job_saved: saved.status === 'retry_wait' && saved.next_attempt_at === retryAt && saved.last_error_code === 'RESOURCE_EXHAUSTED',
      retrieval_reuse_saved: Number(saved.reused) === 1,
      duplicate_active_job_blocked: duplicateBlocked
    };
  } finally {
    db.exec('ROLLBACK TO job_guard_test; RELEASE job_guard_test;');
  }
}

function validate(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys=ON');
  const missingColumns = {};
  for (const [table, expected] of Object.entries(requiredColumns)) {
    const present = new Set(columns(db, table));
    const missing = expected.filter((column) => !present.has(column));
    if (missing.length) missingColumns[table] = missing;
  }
  const actualCounts = rowCounts(db, businessTables);
  let sourceCounts = null;
  let dataPreserved = null;
  if (fs.existsSync(sourceDbPath)) {
    const source = new DatabaseSync(sourceDbPath, { readOnly: true });
    sourceCounts = rowCounts(source, businessTables);
    source.close();
    dataPreserved = businessTables.every((table) => actualCounts[table] >= sourceCounts[table]);
  }
  const subjectUnknownCards = Number(db.prepare("SELECT count(*) AS n FROM memory_cards WHERE subject_key='unknown'").get().n);
  const malformedFactKeys = Number(db.prepare("SELECT count(*) AS n FROM fact_timelines WHERE subject_key IS NULL OR predicate_key IS NULL OR fact_key != subject_key || '.' || predicate_key").get().n);
  const missingCardEvidence = Number(db.prepare('SELECT count(*) AS n FROM memory_sources WHERE evidence_quote IS NULL OR added_at IS NULL').get().n);
  const missingFactEvidence = Number(db.prepare("SELECT count(*) AS n FROM fact_events WHERE evidence_quotes_json='{}'").get().n);
  const unknownFactDomains = Number(db.prepare("SELECT count(*) AS n FROM fact_timelines WHERE domain='unknown'").get().n);
  const result = {
    generated_at: new Date().toISOString(),
    db_path: dbPath,
    schema_version: Number(db.prepare('PRAGMA user_version').get().user_version),
    integrity_check: db.prepare('PRAGMA integrity_check').get().integrity_check,
    foreign_key_errors: db.prepare('PRAGMA foreign_key_check').all(),
    missing_columns: missingColumns,
    baseline_available: sourceCounts !== null,
    data_preserved: dataPreserved,
    source_counts: sourceCounts,
    upgraded_counts: actualCounts,
    routing_checks: {
      cards_with_unknown_subject: subjectUnknownCards,
      malformed_fact_keys: malformedFactKeys,
      timelines_with_unknown_domain: unknownFactDomains
    },
    evidence_checks: {
      card_sources_missing_evidence: missingCardEvidence,
      fact_events_missing_evidence: missingFactEvidence
    },
    summary_actions: db.prepare('SELECT memory_action,count(*) AS count FROM event_summaries GROUP BY memory_action ORDER BY memory_action').all(),
    job_guards: testJobGuards(db)
  };
  result.passed = result.integrity_check === 'ok'
    && result.foreign_key_errors.length === 0
    && Object.keys(result.missing_columns).length === 0
    && result.data_preserved !== false
    && subjectUnknownCards === 0
    && malformedFactKeys === 0
    && missingCardEvidence === 0
    && missingFactEvidence === 0
    && unknownFactDomains === 0
    && result.job_guards.retry_job_saved
    && result.job_guards.retrieval_reuse_saved
    && result.job_guards.duplicate_active_job_blocked;
  db.close();
  return result;
}

const result = validate(path.resolve(process.argv[2] || defaultDbPath));
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.passed) process.exitCode = 1;
