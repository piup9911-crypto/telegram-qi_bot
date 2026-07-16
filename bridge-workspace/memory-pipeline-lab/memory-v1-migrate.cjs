const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const labDir = __dirname;
const defaultDbPath = path.join(labDir, 'memory-v1-lab.sqlite');
const migrationsDir = path.join(labDir, 'memory-v1-migrations');

function migrationFiles() {
  return fs.readdirSync(migrationsDir)
    .filter((name) => /^\d+_.+\.sql$/i.test(name))
    .map((name) => ({ name, version: Number(name.match(/^(\d+)/)[1]) }))
    .sort((a, b) => a.version - b.version);
}

function applyMigrations(dbPath = defaultDbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  const applied = [];
  for (const migration of migrationFiles()) {
    const current = Number(db.prepare('PRAGMA user_version').get().user_version);
    if (migration.version <= current) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, migration.name), 'utf8');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
      applied.push(migration.name);
    } catch (error) {
      db.exec('ROLLBACK');
      db.close();
      throw error;
    }
  }
  const version = Number(db.prepare('PRAGMA user_version').get().user_version);
  db.close();
  return { dbPath, version, applied };
}

if (require.main === module) {
  process.stdout.write(`${JSON.stringify(applyMigrations(process.argv[2] || defaultDbPath), null, 2)}\n`);
}

module.exports = { applyMigrations, defaultDbPath, migrationsDir };
