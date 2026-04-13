import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export type Db = Database.Database;

const SCHEMA_VERSION = 2;

const DDL = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  root_path   TEXT    NOT NULL UNIQUE,
  last_indexed_at TEXT
);

CREATE TABLE IF NOT EXISTS files (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  relative_path   TEXT    NOT NULL,
  content_hash    TEXT,
  last_indexed_at TEXT,
  UNIQUE(project_id, relative_path)
);

CREATE TABLE IF NOT EXISTS symbols (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  kind        TEXT    NOT NULL,
  signature   TEXT,
  parent_id   INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
  start_line  INTEGER NOT NULL,
  end_line    INTEGER NOT NULL,
  modifiers   TEXT,
  annotations TEXT
);

CREATE TABLE IF NOT EXISTS dependencies (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  source_file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  target_fqn     TEXT    NOT NULL,
  kind           TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS refs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  source_symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
  target_symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL,
  callee_name      TEXT          -- stored for cross-file resolution; null once resolved
);

CREATE TABLE IF NOT EXISTS summaries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id       INTEGER REFERENCES files(id) ON DELETE CASCADE,
  symbol_id     INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
  content       TEXT NOT NULL,
  generated_at  TEXT NOT NULL,
  model_version TEXT NOT NULL,
  UNIQUE(file_id, symbol_id)
);

CREATE INDEX IF NOT EXISTS idx_files_project    ON files(project_id);
CREATE INDEX IF NOT EXISTS idx_symbols_file     ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_symbols_name     ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_kind     ON symbols(kind);
CREATE INDEX IF NOT EXISTS idx_symbols_parent   ON symbols(parent_id);
CREATE INDEX IF NOT EXISTS idx_deps_source      ON dependencies(source_file_id);
CREATE INDEX IF NOT EXISTS idx_refs_source      ON refs(source_symbol_id);
CREATE INDEX IF NOT EXISTS idx_refs_target      ON refs(target_symbol_id);
CREATE INDEX IF NOT EXISTS idx_summaries_file   ON summaries(file_id);
CREATE INDEX IF NOT EXISTS idx_summaries_symbol ON summaries(symbol_id);

CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
  name, signature, annotations,
  content=symbols,
  content_rowid=id
);

CREATE VIRTUAL TABLE IF NOT EXISTS summaries_fts USING fts5(
  content,
  content=summaries,
  content_rowid=id
);

CREATE TRIGGER IF NOT EXISTS symbols_ai AFTER INSERT ON symbols BEGIN
  INSERT INTO symbols_fts(rowid, name, signature, annotations)
  VALUES (new.id, new.name, new.signature, new.annotations);
END;

CREATE TRIGGER IF NOT EXISTS symbols_ad AFTER DELETE ON symbols BEGIN
  INSERT INTO symbols_fts(symbols_fts, rowid, name, signature, annotations)
  VALUES ('delete', old.id, old.name, old.signature, old.annotations);
END;

CREATE TRIGGER IF NOT EXISTS symbols_au AFTER UPDATE ON symbols BEGIN
  INSERT INTO symbols_fts(symbols_fts, rowid, name, signature, annotations)
  VALUES ('delete', old.id, old.name, old.signature, old.annotations);
  INSERT INTO symbols_fts(rowid, name, signature, annotations)
  VALUES (new.id, new.name, new.signature, new.annotations);
END;
`;

export function openDatabase(dbPath: string): Db {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

  applySchema(db);
  return db;
}

function applySchema(db: Db): void {
  const existing = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'"
  ).get();

  if (!existing) {
    db.exec(DDL);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
    return;
  }

  const row = db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
  const current = row?.version ?? 0;

  if (current < SCHEMA_VERSION) {
    if (current < 2) {
      // v1 → v2: add callee_name column to refs for cross-file resolution
      db.exec('ALTER TABLE refs ADD COLUMN callee_name TEXT');
    }
    db.prepare('UPDATE schema_version SET version = ?').run(SCHEMA_VERSION);
  }
}
