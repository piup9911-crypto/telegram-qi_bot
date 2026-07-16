PRAGMA foreign_keys = ON;

-- Per-message review state proves that a complete conversation import was
-- considered, including messages intentionally left only in the raw archive.
ALTER TABLE raw_messages ADD COLUMN memory_review_status TEXT NOT NULL DEFAULT 'unreviewed'
  CHECK (memory_review_status IN ('unreviewed', 'summary', 'evidence', 'raw_only', 'test_fixture'));
ALTER TABLE raw_messages ADD COLUMN memory_review_reason TEXT;
ALTER TABLE raw_messages ADD COLUMN memory_reviewed_at TEXT;
ALTER TABLE raw_messages ADD COLUMN memory_policy_version TEXT;

CREATE INDEX IF NOT EXISTS idx_raw_messages_memory_review
  ON raw_messages(conversation_id, memory_review_status, source_message_index);
