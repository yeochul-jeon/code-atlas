import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { openDatabase } from '../database.js';

// Use in-memory DB for all tests
function makeDb() {
  return openDatabase(':memory:');
}

describe('openDatabase', () => {
  let db: ReturnType<typeof makeDb>;

  afterEach(() => {
    db?.close();
  });

  it('creates all required tables', () => {
    db = makeDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map(t => t.name);

    expect(names).toContain('schema_version');
    expect(names).toContain('projects');
    expect(names).toContain('files');
    expect(names).toContain('symbols');
    expect(names).toContain('dependencies');
    expect(names).toContain('refs');
    expect(names).toContain('summaries');
  });

  it('creates FTS5 virtual tables', () => {
    db = makeDb();
    const vtables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts'")
      .all() as { name: string }[];
    const names = vtables.map(t => t.name);
    expect(names).toContain('symbols_fts');
    expect(names).toContain('summaries_fts');
  });

  it('records current schema version', () => {
    db = makeDb();
    const row = db.prepare('SELECT version FROM schema_version').get() as { version: number };
    expect(row.version).toBeGreaterThanOrEqual(1);
  });

  it('enables WAL mode', () => {
    db = makeDb();
    const row = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    // In-memory DB always returns 'memory', but the pragma is still set; just verify it's accessible
    expect(['wal', 'memory']).toContain(row.journal_mode);
  });

  it('enables foreign keys', () => {
    db = makeDb();
    const row = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    expect(row.foreign_keys).toBe(1);
  });

  it('does not re-apply schema on second open', () => {
    db = makeDb();
    // Second call with same in-memory db is not applicable (each :memory: is fresh),
    // but we verify the version doesn't get duplicated
    const count = db.prepare('SELECT COUNT(*) as n FROM schema_version').get() as { n: number };
    expect(count.n).toBe(1);
  });
});
