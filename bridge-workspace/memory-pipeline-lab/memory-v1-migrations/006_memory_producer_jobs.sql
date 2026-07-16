PRAGMA foreign_keys = ON;

-- Keep the producer audit trail on the operational job table. These columns
-- do not create another kind of memory; they explain what the producer saw,
-- whether it passed evidence validation, and what was actually committed.
ALTER TABLE memory_processing_jobs ADD COLUMN input_hash TEXT;
ALTER TABLE memory_processing_jobs ADD COLUMN output_json TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(output_json));
ALTER TABLE memory_processing_jobs ADD COLUMN validation_json TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(validation_json));
ALTER TABLE memory_processing_jobs ADD COLUMN write_result_json TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(write_result_json));
ALTER TABLE memory_processing_jobs ADD COLUMN processor_version TEXT;
ALTER TABLE memory_processing_jobs ADD COLUMN committed_at TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_jobs_kind_input_hash
  ON memory_processing_jobs(job_kind, input_hash)
  WHERE input_hash IS NOT NULL;
