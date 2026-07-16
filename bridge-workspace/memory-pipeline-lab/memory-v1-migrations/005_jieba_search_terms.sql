PRAGMA foreign_keys = ON;

-- Rebuildable Chinese-word search index. The source of truth remains in the
-- eight business tables; these rows may be deleted and regenerated at any time.
CREATE TABLE IF NOT EXISTS memory_search_documents (
  id INTEGER PRIMARY KEY,
  target_id TEXT NOT NULL UNIQUE,
  target_type TEXT NOT NULL CHECK (target_type IN ('raw','card','summary','goal','event','fact')),
  subject_key TEXT,
  local_date TEXT,
  words_text TEXT NOT NULL,
  aliases_text TEXT NOT NULL DEFAULT '',
  source_hash TEXT NOT NULL,
  tokenizer_version TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_search_documents_route
  ON memory_search_documents(target_type,subject_key,local_date);

-- Jieba has already inserted spaces between Chinese words. unicode61 only has
-- to index those stable tokens; the existing trigram indexes remain unchanged.
CREATE VIRTUAL TABLE IF NOT EXISTS memory_search_terms_fts USING fts5(
  words_text,
  aliases_text,
  content='memory_search_documents',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS memory_search_documents_ai AFTER INSERT ON memory_search_documents BEGIN
  INSERT INTO memory_search_terms_fts(rowid,words_text,aliases_text)
  VALUES (new.id,new.words_text,new.aliases_text);
END;
CREATE TRIGGER IF NOT EXISTS memory_search_documents_ad AFTER DELETE ON memory_search_documents BEGIN
  INSERT INTO memory_search_terms_fts(memory_search_terms_fts,rowid,words_text,aliases_text)
  VALUES ('delete',old.id,old.words_text,old.aliases_text);
END;
CREATE TRIGGER IF NOT EXISTS memory_search_documents_au AFTER UPDATE ON memory_search_documents BEGIN
  INSERT INTO memory_search_terms_fts(memory_search_terms_fts,rowid,words_text,aliases_text)
  VALUES ('delete',old.id,old.words_text,old.aliases_text);
  INSERT INTO memory_search_terms_fts(rowid,words_text,aliases_text)
  VALUES (new.id,new.words_text,new.aliases_text);
END;
