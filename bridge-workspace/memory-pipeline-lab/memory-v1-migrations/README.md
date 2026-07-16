# Memory V1 migrations

The migration runner defaults to `memory-v1-lab.sqlite` for isolated work. The
formal bridge and recall runtime currently use `memory-schema-v2-complete.sqlite`;
pass that path explicitly when applying a migration to the runtime database.
Every database uses SQLite `PRAGMA user_version` as its schema version. The
runner applies numbered SQL files in ascending order and never re-applies a
version that is already present.

## Rules

1. Never edit a numbered migration after it has been applied to a database.
2. Add the next file, for example `002_add_memory_confidence.sql`.
3. Run `node memory-pipeline-lab/memory-v1-migrate.cjs <database-path>`.
4. Run `node memory-pipeline-lab/validate-memory-schema-v2.cjs` and the
   feature-specific recall/index validators.
5. Back up the database before a migration that copies or removes data.

## Adding a field

An additive field is the simplest migration:

```sql
ALTER TABLE memory_cards ADD COLUMN confidence REAL;
```

If old rows need a value, backfill them in the same migration or in a bounded
follow-up job. New application code must tolerate both the old default and the
new value during deployment.

## Adding a logical table

Create the table and its indexes in the next migration. Update the logical
table manifest and validation script. Existing business-table data does not need
to be rebuilt unless the new table derives rows from existing records.

## Changing constraints or primary keys

SQLite usually requires a copy migration:

1. Create `table_name_v2` with the new schema.
2. Copy and transform rows from the old table.
3. Run row-count, uniqueness, JSON, and foreign-key checks.
4. Rename the old table and then rename v2 into place.
5. Keep the old table until the migration is verified, then remove it in a
   later migration.

## Changing the FTS tokenizer

FTS is a rebuildable auxiliary index. Do not rewrite or delete `raw_messages`.

1. Create a versioned virtual table such as `raw_messages_fts_v2` with the new
   tokenizer.
2. Populate it from the canonical raw table:

   ```sql
   INSERT INTO raw_messages_fts_v2(rowid, text)
   SELECT rowid, text FROM raw_messages;
   ```

3. Test old and new indexes against the same evaluation questions.
4. Add v2 insert/update/delete triggers.
5. Switch retrieval code to v2 only after the comparison passes.
6. Keep v1 for a rollback window; remove it in a later migration.

SQLite Browser will display FTS virtual tables and their generated shadow
tables. They are search infrastructure, not additional memory business tables.

Migration `005_jieba_search_terms.sql` follows this rule: it leaves all trigram
tables intact and adds a rebuildable `unicode61` index over text that has already
been segmented by Jieba outside SQLite.

## Changing the embedding model

Embeddings are also derived indexes. Keep the raw message id, embedding model,
dimension, and source fingerprint in the cache metadata. Build a new cache next
to the old one, evaluate it, then switch. A model change does not require
altering the eight business tables.
