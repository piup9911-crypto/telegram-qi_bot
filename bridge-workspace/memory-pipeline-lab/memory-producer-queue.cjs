const crypto = require('crypto');
const systemConfig = require('./memory-system-config.json');

const PRODUCER_VERSION = 'memory-producer-v1';

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function selectPendingMessages(db, options = {}) {
  const maxMessages = Math.max(1, Number(options.maxMessages || systemConfig.producer.batch_max_messages));
  const maxChars = Math.max(500, Number(options.maxChars || systemConfig.producer.batch_max_chars));
  let conversationId = options.conversationId || null;
  if (!conversationId) {
    conversationId = db.prepare(`
      SELECT conversation_id FROM raw_messages
      WHERE memory_review_status='unreviewed'
      ORDER BY timestamp,source_message_index LIMIT 1
    `).get()?.conversation_id || null;
  }
  if (!conversationId) return [];

  const candidates = db.prepare(`
    SELECT id,conversation_id,message_index,source_message_index,speaker,text,timestamp,local_date,
           memory_review_status
    FROM raw_messages
    WHERE conversation_id=? AND memory_review_status='unreviewed'
    ORDER BY source_message_index LIMIT ?
  `).all(conversationId, maxMessages);
  const selected = [];
  let chars = 0;
  for (const row of candidates) {
    const nextChars = String(row.text || '').length;
    if (selected.length && chars + nextChars > maxChars) break;
    selected.push(row);
    chars += nextChars;
  }
  return selected.some((row) => row.speaker === 'user') ? selected : [];
}

function loadMessagesByIds(db, ids) {
  if (!Array.isArray(ids) || !ids.length) return [];
  const get = db.prepare(`
    SELECT id,conversation_id,message_index,source_message_index,speaker,text,timestamp,local_date,
           memory_review_status
    FROM raw_messages WHERE id=?
  `);
  const rows = ids.map((id) => get.get(id)).filter(Boolean);
  const order = new Map(ids.map((id, index) => [id, index]));
  return rows.sort((a, b) => order.get(a.id) - order.get(b.id));
}

function enqueueMemoryBatch(db, options = {}) {
  const now = options.now || new Date().toISOString();
  const jobKind = options.jobKind || 'segment_summarize';
  const triggerKind = options.triggerKind || 'idle_batch';
  const messages = options.messageIds
    ? loadMessagesByIds(db, options.messageIds)
    : selectPendingMessages(db, options);
  if (!messages.length) return { created: false, reason: 'no_eligible_messages' };
  if (!messages.some((row) => row.speaker === 'user')) {
    return { created: false, reason: 'no_user_message' };
  }
  const conversationIds = [...new Set(messages.map((row) => row.conversation_id))];
  if (conversationIds.length !== 1) throw new Error('A producer batch must belong to one conversation.');
  const conversationId = conversationIds[0];
  const ids = messages.map((row) => row.id);
  const inputHash = sha256(JSON.stringify({ producer: PRODUCER_VERSION, jobKind, conversationId, ids }));
  const existing = db.prepare(`
    SELECT * FROM memory_processing_jobs WHERE job_kind=? AND input_hash=?
  `).get(jobKind, inputHash);
  if (existing) return { created: false, reason: 'already_enqueued', job: existing, messages };

  const active = db.prepare(`
    SELECT * FROM memory_processing_jobs
    WHERE conversation_id=? AND job_kind=? AND status IN ('pending','running','retry_wait')
    LIMIT 1
  `).get(conversationId, jobKind);
  if (active) return { created: false, reason: 'active_job_exists', job: active, messages };

  const id = `producer_job:${inputHash.slice(0, 24)}`;
  db.prepare(`
    INSERT INTO memory_processing_jobs(
      id,conversation_id,job_kind,trigger_kind,status,priority,input_message_ids_json,
      retrieval_trace_json,provider,model,policy_version,attempt_count,max_attempts,
      next_attempt_at,created_at,updated_at,input_hash,processor_version
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id, conversationId, jobKind, triggerKind, 'pending', Number(options.priority || 100),
    JSON.stringify(ids), JSON.stringify(options.retrievalTrace || {}), options.provider || 'disabled',
    options.model || null, options.policyVersion || 'memory-policy-v1', 0,
    Number(options.maxAttempts || systemConfig.producer.max_attempts), now, now, now, inputHash, PRODUCER_VERSION
  );
  return { created: true, job: db.prepare('SELECT * FROM memory_processing_jobs WHERE id=?').get(id), messages };
}

function decodeJob(job) {
  return { ...job, input_message_ids: parseJson(job.input_message_ids_json, []) };
}

module.exports = { PRODUCER_VERSION, sha256, selectPendingMessages, loadMessagesByIds, enqueueMemoryBatch, decodeJob };
