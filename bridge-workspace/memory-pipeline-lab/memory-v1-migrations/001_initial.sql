PRAGMA foreign_keys = ON;

-- Seven logical business tables. FTS virtual tables and views below are auxiliary.
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL,
  title TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  source_file TEXT NOT NULL,
  boundary_reason TEXT NOT NULL DEFAULT 'source_stream',
  imported_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS raw_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_index INTEGER NOT NULL,
  source_message_index INTEGER NOT NULL,
  speaker TEXT NOT NULL CHECK (speaker IN ('user', 'assistant', 'system')),
  text TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  local_date TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  UNIQUE (conversation_id, source_message_index)
);

CREATE TABLE IF NOT EXISTS event_summaries (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  start_message_index INTEGER NOT NULL,
  end_message_index INTEGER NOT NULL,
  topic_key TEXT NOT NULL,
  topic TEXT NOT NULL,
  summary_mode TEXT NOT NULL CHECK (summary_mode IN ('index', 'detailed')),
  gist TEXT NOT NULL,
  source_spans_json TEXT NOT NULL CHECK (json_valid(source_spans_json)),
  observation_ids_json TEXT NOT NULL CHECK (json_valid(observation_ids_json)),
  user_goals_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(user_goals_json)),
  user_confirmed_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(user_confirmed_json)),
  assistant_proposals_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(assistant_proposals_json)),
  open_questions_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(open_questions_json)),
  retrieval_terms_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(retrieval_terms_json)),
  source_generation TEXT NOT NULL,
  content_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  card_decision TEXT CHECK (card_decision IN ('created', 'partial', 'none')),
  card_reason TEXT,
  CHECK (start_message_index <= end_message_index)
);

CREATE TABLE IF NOT EXISTS fact_timelines (
  id TEXT PRIMARY KEY,
  fact_key TEXT NOT NULL UNIQUE,
  topic TEXT NOT NULL,
  current_event_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (current_event_id) REFERENCES fact_events(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS memory_cards (
  id TEXT PRIMARY KEY,
  memory_type TEXT NOT NULL CHECK (memory_type IN ('stable', 'episode', 'plan', 'pattern', 'tracker')),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  domain TEXT NOT NULL,
  topic TEXT NOT NULL,
  status TEXT NOT NULL,
  source_identity TEXT NOT NULL,
  derived_from_summary_id TEXT REFERENCES event_summaries(id) ON DELETE SET NULL,
  timeline_id TEXT REFERENCES fact_timelines(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  write_reason TEXT
);

CREATE TABLE IF NOT EXISTS memory_sources (
  id TEXT PRIMARY KEY,
  memory_card_id TEXT NOT NULL REFERENCES memory_cards(id) ON DELETE CASCADE,
  raw_message_id TEXT NOT NULL REFERENCES raw_messages(id) ON DELETE CASCADE,
  relation TEXT NOT NULL CHECK (relation IN ('supports', 'contradicts', 'mentions')),
  UNIQUE (memory_card_id, raw_message_id, relation)
);

CREATE TABLE IF NOT EXISTS fact_events (
  id TEXT PRIMARY KEY,
  timeline_id TEXT NOT NULL REFERENCES fact_timelines(id) ON DELETE CASCADE,
  source_message_id TEXT NOT NULL REFERENCES raw_messages(id) ON DELETE RESTRICT,
  valid_at TEXT,
  valid_at_precision TEXT NOT NULL DEFAULT 'unknown'
    CHECK (valid_at_precision IN ('exact', 'day', 'month', 'approximate', 'unknown')),
  observed_at TEXT NOT NULL,
  content TEXT NOT NULL,
  evidence_status TEXT NOT NULL
    CHECK (evidence_status IN ('user_explicit', 'user_reported', 'assistant_claimed', 'system_verified')),
  is_current INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_raw_messages_time
  ON raw_messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_raw_messages_local_date
  ON raw_messages(local_date);
CREATE INDEX IF NOT EXISTS idx_raw_messages_position
  ON raw_messages(conversation_id, source_message_index);
CREATE INDEX IF NOT EXISTS idx_raw_messages_speaker
  ON raw_messages(speaker);
CREATE INDEX IF NOT EXISTS idx_event_summaries_topic
  ON event_summaries(topic_key, summary_mode);
CREATE INDEX IF NOT EXISTS idx_event_summaries_range
  ON event_summaries(conversation_id, start_message_index, end_message_index);
CREATE INDEX IF NOT EXISTS idx_memory_cards_topic
  ON memory_cards(domain, topic, status);
CREATE INDEX IF NOT EXISTS idx_fact_events_timeline_time
  ON fact_events(timeline_id, valid_at, observed_at);

CREATE VIRTUAL TABLE IF NOT EXISTS raw_messages_fts USING fts5(
  text,
  content='raw_messages',
  content_rowid='rowid',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS raw_messages_ai AFTER INSERT ON raw_messages BEGIN
  INSERT INTO raw_messages_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS raw_messages_ad AFTER DELETE ON raw_messages BEGIN
  INSERT INTO raw_messages_fts(raw_messages_fts, rowid, text)
  VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS raw_messages_au AFTER UPDATE ON raw_messages BEGIN
  INSERT INTO raw_messages_fts(raw_messages_fts, rowid, text)
  VALUES ('delete', old.rowid, old.text);
  INSERT INTO raw_messages_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS event_summaries_fts USING fts5(
  topic,
  gist,
  retrieval_terms_json,
  content='event_summaries',
  content_rowid='rowid',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS event_summaries_ai AFTER INSERT ON event_summaries BEGIN
  INSERT INTO event_summaries_fts(rowid, topic, gist, retrieval_terms_json)
  VALUES (new.rowid, new.topic, new.gist, new.retrieval_terms_json);
END;
CREATE TRIGGER IF NOT EXISTS event_summaries_ad AFTER DELETE ON event_summaries BEGIN
  INSERT INTO event_summaries_fts(event_summaries_fts, rowid, topic, gist, retrieval_terms_json)
  VALUES ('delete', old.rowid, old.topic, old.gist, old.retrieval_terms_json);
END;
CREATE TRIGGER IF NOT EXISTS event_summaries_au AFTER UPDATE ON event_summaries BEGIN
  INSERT INTO event_summaries_fts(event_summaries_fts, rowid, topic, gist, retrieval_terms_json)
  VALUES ('delete', old.rowid, old.topic, old.gist, old.retrieval_terms_json);
  INSERT INTO event_summaries_fts(rowid, topic, gist, retrieval_terms_json)
  VALUES (new.rowid, new.topic, new.gist, new.retrieval_terms_json);
END;

CREATE VIEW IF NOT EXISTS view_event_summary_overview AS
SELECT
  s.id,
  s.topic,
  s.summary_mode,
  s.gist,
  json_array_length(s.source_spans_json) AS source_span_count,
  json_array_length(s.observation_ids_json) AS observation_count,
  s.start_message_index,
  s.end_message_index,
  s.card_decision
FROM event_summaries s
ORDER BY s.start_message_index;

CREATE VIEW IF NOT EXISTS view_memory_and_source AS
SELECT
  c.id AS memory_id,
  c.title AS memory_title,
  c.memory_type,
  c.status,
  c.content AS memory_content,
  m.id AS source_message_id,
  m.speaker AS source_speaker,
  m.text AS source_text,
  m.timestamp AS source_time,
  s.relation
FROM memory_cards c
JOIN memory_sources s ON s.memory_card_id = c.id
JOIN raw_messages m ON m.id = s.raw_message_id;

CREATE VIEW IF NOT EXISTS view_timeline_and_source AS
SELECT
  t.fact_key,
  e.valid_at,
  e.valid_at_precision,
  e.observed_at,
  e.content AS fact_content,
  e.evidence_status,
  e.is_current,
  m.id AS source_message_id,
  m.speaker AS source_speaker,
  m.text AS source_text
FROM fact_timelines t
JOIN fact_events e ON e.timeline_id = t.id
JOIN raw_messages m ON m.id = e.source_message_id
ORDER BY COALESCE(e.valid_at, e.observed_at), e.observed_at;
