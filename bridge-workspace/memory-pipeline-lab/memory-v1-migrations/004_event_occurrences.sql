PRAGMA foreign_keys = ON;

-- Rebuildable historical-event index. This is a retrieval aid, not a Memory Card
-- and not a statement of current truth. Multiple rows may describe lifecycle
-- transitions for one occurrence_key.
CREATE TABLE IF NOT EXISTS event_occurrences (
  id TEXT PRIMARY KEY,
  event_key TEXT NOT NULL,
  occurrence_key TEXT NOT NULL,
  event_label TEXT NOT NULL,
  event_text TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(aliases_json)),
  subject_key TEXT NOT NULL,
  event_status TEXT NOT NULL CHECK (event_status IN (
    'mentioned','requested','planned','started','in_progress',
    'completed','failed','refused','stopped','uncertain'
  )),
  occurred_at TEXT NOT NULL,
  ended_at TEXT,
  local_date TEXT NOT NULL,
  time_precision TEXT NOT NULL DEFAULT 'exact'
    CHECK (time_precision IN ('exact','day','month','approximate','unknown')),
  summary_id TEXT REFERENCES event_summaries(id) ON DELETE SET NULL,
  source_message_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_message_ids_json)),
  evidence_quotes_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(evidence_quotes_json)),
  evidence_status TEXT NOT NULL CHECK (evidence_status IN (
    'user_explicit','user_reported','mixed_transcript','assistant_only','system_verified'
  )),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  sensitivity TEXT NOT NULL DEFAULT 'ordinary'
    CHECK (sensitivity IN ('ordinary','personal','sensitive')),
  recall_scope TEXT NOT NULL DEFAULT 'relevant_only'
    CHECK (recall_scope IN ('always','relevant_only','explicit_only')),
  policy_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (occurrence_key, event_status, occurred_at)
);

CREATE INDEX IF NOT EXISTS idx_event_occurrences_route
  ON event_occurrences(subject_key,event_key,event_status,local_date);
CREATE INDEX IF NOT EXISTS idx_event_occurrences_time
  ON event_occurrences(event_key,occurred_at,occurrence_key);
CREATE INDEX IF NOT EXISTS idx_event_occurrences_summary
  ON event_occurrences(summary_id);

CREATE VIRTUAL TABLE IF NOT EXISTS event_occurrences_fts USING fts5(
  event_label,
  event_text,
  aliases_json,
  content='event_occurrences',
  content_rowid='rowid',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS event_occurrences_ai AFTER INSERT ON event_occurrences BEGIN
  INSERT INTO event_occurrences_fts(rowid,event_label,event_text,aliases_json)
  VALUES (new.rowid,new.event_label,new.event_text,new.aliases_json);
END;
CREATE TRIGGER IF NOT EXISTS event_occurrences_ad AFTER DELETE ON event_occurrences BEGIN
  INSERT INTO event_occurrences_fts(event_occurrences_fts,rowid,event_label,event_text,aliases_json)
  VALUES ('delete',old.rowid,old.event_label,old.event_text,old.aliases_json);
END;
CREATE TRIGGER IF NOT EXISTS event_occurrences_au AFTER UPDATE ON event_occurrences BEGIN
  INSERT INTO event_occurrences_fts(event_occurrences_fts,rowid,event_label,event_text,aliases_json)
  VALUES ('delete',old.rowid,old.event_label,old.event_text,old.aliases_json);
  INSERT INTO event_occurrences_fts(rowid,event_label,event_text,aliases_json)
  VALUES (new.rowid,new.event_label,new.event_text,new.aliases_json);
END;

CREATE VIEW IF NOT EXISTS view_event_occurrences_with_summary AS
SELECT e.*,s.topic AS summary_topic,s.gist AS summary_gist
FROM event_occurrences e
LEFT JOIN event_summaries s ON s.id=e.summary_id
ORDER BY e.occurred_at,e.id;
