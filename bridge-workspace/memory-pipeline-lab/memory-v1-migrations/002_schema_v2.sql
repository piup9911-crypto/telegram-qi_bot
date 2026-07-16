PRAGMA foreign_keys = ON;

-- Canonical V2 additions. The seven memory business tables remain unchanged.
-- memory_processing_jobs is an operational queue, not a memory store.

ALTER TABLE conversations ADD COLUMN timezone_name TEXT NOT NULL DEFAULT 'Asia/Shanghai';

ALTER TABLE event_summaries ADD COLUMN memory_action TEXT NOT NULL DEFAULT 'pending'
  CHECK (memory_action IN ('pending', 'card', 'timeline', 'both', 'event_only'));
ALTER TABLE event_summaries ADD COLUMN memory_processed_at TEXT;
ALTER TABLE event_summaries ADD COLUMN memory_policy_version TEXT;

ALTER TABLE memory_cards ADD COLUMN subject_key TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE memory_cards ADD COLUMN memory_key TEXT;
ALTER TABLE memory_cards ADD COLUMN sensitivity TEXT NOT NULL DEFAULT 'ordinary'
  CHECK (sensitivity IN ('ordinary', 'personal', 'sensitive'));
ALTER TABLE memory_cards ADD COLUMN recall_scope TEXT NOT NULL DEFAULT 'relevant_only'
  CHECK (recall_scope IN ('always', 'relevant_only', 'explicit_only'));

-- Existing lab cards were created only from the user's explicit messages.
UPDATE memory_cards
SET subject_key = 'user'
WHERE subject_key = 'unknown' AND source_identity LIKE 'user_%';

ALTER TABLE memory_sources ADD COLUMN evidence_quote TEXT;
ALTER TABLE memory_sources ADD COLUMN added_at TEXT;

ALTER TABLE fact_timelines ADD COLUMN subject_key TEXT;
ALTER TABLE fact_timelines ADD COLUMN predicate_key TEXT;
ALTER TABLE fact_timelines ADD COLUMN domain TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE fact_timelines ADD COLUMN sensitivity TEXT NOT NULL DEFAULT 'ordinary'
  CHECK (sensitivity IN ('ordinary', 'personal', 'sensitive'));
ALTER TABLE fact_timelines ADD COLUMN recall_scope TEXT NOT NULL DEFAULT 'relevant_only'
  CHECK (recall_scope IN ('always', 'relevant_only', 'explicit_only'));

UPDATE fact_timelines
SET subject_key = substr(fact_key, 1, instr(fact_key, '.') - 1),
    predicate_key = substr(fact_key, instr(fact_key, '.') + 1)
WHERE instr(fact_key, '.') > 1;

ALTER TABLE fact_events ADD COLUMN value_text TEXT;
ALTER TABLE fact_events ADD COLUMN event_kind TEXT NOT NULL DEFAULT 'state_change'
  CHECK (event_kind IN ('state_change', 'supporting_evidence', 'historical_event'));
ALTER TABLE fact_events ADD COLUMN source_claim_key TEXT;
ALTER TABLE fact_events ADD COLUMN invalid_at TEXT;
ALTER TABLE fact_events ADD COLUMN recorded_at TEXT;
ALTER TABLE fact_events ADD COLUMN source_message_ids_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(source_message_ids_json));
ALTER TABLE fact_events ADD COLUMN evidence_quotes_json TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(evidence_quotes_json));
ALTER TABLE fact_events ADD COLUMN temporal_basis TEXT NOT NULL DEFAULT 'legacy_observation'
  CHECK (temporal_basis IN ('explicit_text', 'source_timestamp', 'legacy_observation', 'unknown'));
ALTER TABLE fact_events ADD COLUMN correction_of_event_id TEXT
  REFERENCES fact_events(id) ON DELETE SET NULL;

UPDATE fact_events
SET recorded_at = observed_at,
    source_message_ids_json = json_array(source_message_id)
WHERE recorded_at IS NULL;

CREATE TABLE IF NOT EXISTS memory_processing_jobs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  summary_id TEXT REFERENCES event_summaries(id) ON DELETE SET NULL,
  job_kind TEXT NOT NULL
    CHECK (job_kind IN ('segment_summarize', 'recall_consolidate', 'historical_backfill')),
  trigger_kind TEXT NOT NULL
    CHECK (trigger_kind IN ('recall_memory', 'explicit_remember', 'explicit_correction', 'idle_batch', 'manual_test')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'retry_wait', 'succeeded', 'failed', 'cancelled')),
  priority INTEGER NOT NULL DEFAULT 100,
  input_message_ids_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(input_message_ids_json)),
  retrieval_trace_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(retrieval_trace_json)),
  provider TEXT,
  model TEXT,
  policy_version TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts >= 1),
  next_attempt_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (attempt_count <= max_attempts)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_cards_memory_key
  ON memory_cards(memory_key)
  WHERE memory_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memory_cards_subject_route
  ON memory_cards(subject_key, domain, memory_type, status);
CREATE INDEX IF NOT EXISTS idx_fact_timeline_subject_route
  ON fact_timelines(subject_key, domain, predicate_key);
CREATE INDEX IF NOT EXISTS idx_fact_events_validity
  ON fact_events(timeline_id, valid_at, invalid_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fact_events_source_claim_key
  ON fact_events(source_claim_key)
  WHERE source_claim_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_fact_events_one_current_state
  ON fact_events(timeline_id)
  WHERE is_current = 1;
CREATE INDEX IF NOT EXISTS idx_fact_events_correction
  ON fact_events(correction_of_event_id)
  WHERE correction_of_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memory_jobs_ready
  ON memory_processing_jobs(status, next_attempt_at, priority, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_jobs_one_active_kind
  ON memory_processing_jobs(conversation_id, job_kind)
  WHERE conversation_id IS NOT NULL
    AND status IN ('pending', 'running', 'retry_wait');

DROP VIEW IF EXISTS view_event_summary_overview;
CREATE VIEW view_event_summary_overview AS
SELECT
  s.id,
  s.topic,
  s.summary_mode,
  s.gist,
  json_array_length(s.source_spans_json) AS source_span_count,
  json_array_length(s.observation_ids_json) AS observation_count,
  s.start_message_index,
  s.end_message_index,
  s.memory_action,
  s.memory_processed_at,
  s.card_decision
FROM event_summaries s
ORDER BY s.start_message_index;

DROP VIEW IF EXISTS view_memory_and_source;
CREATE VIEW view_memory_and_source AS
SELECT
  c.id AS memory_id,
  c.subject_key,
  c.memory_key,
  c.title AS memory_title,
  c.memory_type,
  c.status,
  c.content AS memory_content,
  m.id AS source_message_id,
  m.speaker AS source_speaker,
  m.text AS source_text,
  m.timestamp AS source_time,
  s.evidence_quote,
  s.relation
FROM memory_cards c
JOIN memory_sources s ON s.memory_card_id = c.id
JOIN raw_messages m ON m.id = s.raw_message_id;

DROP VIEW IF EXISTS view_timeline_and_source;
CREATE VIEW view_timeline_and_source AS
SELECT
  t.fact_key,
  t.subject_key,
  t.domain,
  t.predicate_key,
  e.valid_at,
  e.invalid_at,
  e.valid_at_precision,
  e.observed_at,
  e.recorded_at,
  e.content AS fact_content,
  e.value_text,
  e.event_kind,
  e.evidence_status,
  e.is_current,
  e.correction_of_event_id,
  e.source_message_id AS primary_source_message_id,
  e.source_message_ids_json,
  e.evidence_quotes_json
FROM fact_timelines t
JOIN fact_events e ON e.timeline_id = t.id
ORDER BY t.fact_key, COALESCE(e.valid_at, e.observed_at), e.observed_at;
