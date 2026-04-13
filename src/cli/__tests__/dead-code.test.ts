import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, type Db } from '../../storage/database.js';
import {
  upsertProject,
  upsertFile,
  insertSymbol,
  insertRef,
} from '../../storage/queries.js';
import { deadCodeAction } from '../dead-code.js';

let db: Db;

beforeEach(() => {
  db = openDatabase(':memory:');
});

afterEach(() => {
  db.close();
});

describe('deadCodeAction', () => {
  // Cycle 1
  it('finds dead code for a project resolved by name', () => {
    const p = upsertProject(db, 'my-app', '/projects/my-app');
    const f = upsertFile(db, p.id, 'src/Foo.java', 'abc');
    insertSymbol(db, {
      file_id: f.id, name: 'unusedMethod', kind: 'method',
      start_line: 10, end_line: 20, signature: 'void unusedMethod()',
    });

    const result = deadCodeAction(db, 'my-app');

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('unusedMethod');
    expect(result.output).toContain('src/Foo.java');
  });

  // Cycle 2
  it('finds dead code for a project resolved by absolute path', () => {
    const p = upsertProject(db, 'my-app', '/projects/my-app');
    const f = upsertFile(db, p.id, 'src/Bar.java', 'def');
    insertSymbol(db, {
      file_id: f.id, name: 'orphanClass', kind: 'class',
      start_line: 1, end_line: 50,
    });

    const result = deadCodeAction(db, '/projects/my-app');

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('orphanClass');
  });

  // Cycle 3
  it('returns error and exitCode 1 when project not found', () => {
    upsertProject(db, 'other-project', '/other');

    const result = deadCodeAction(db, 'nonexistent');

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Project not found');
    expect(result.output).toContain('nonexistent');
    expect(result.output).toContain('codeatlas list');
  });

  // Cycle 4
  it('searches all projects when no project argument is given', () => {
    const p1 = upsertProject(db, 'app-a', '/a');
    const f1 = upsertFile(db, p1.id, 'A.java', 'h1');
    insertSymbol(db, { file_id: f1.id, name: 'deadInA', kind: 'method', start_line: 1, end_line: 5 });

    const p2 = upsertProject(db, 'app-b', '/b');
    const f2 = upsertFile(db, p2.id, 'B.java', 'h2');
    insertSymbol(db, { file_id: f2.id, name: 'deadInB', kind: 'method', start_line: 1, end_line: 5 });

    const result = deadCodeAction(db);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('deadInA');
    expect(result.output).toContain('deadInB');
  });

  // Cycle 5
  it('filters by kind when kind option is provided', () => {
    const p = upsertProject(db, 'my-app', '/projects/my-app');
    const f = upsertFile(db, p.id, 'src/Mixed.java', 'xyz');
    insertSymbol(db, { file_id: f.id, name: 'unusedField', kind: 'field', start_line: 1, end_line: 1 });
    insertSymbol(db, { file_id: f.id, name: 'unusedMethod', kind: 'method', start_line: 3, end_line: 8 });

    const result = deadCodeAction(db, 'my-app', 'method');

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('unusedMethod');
    expect(result.output).not.toContain('unusedField');
  });

  // Cycle 6
  it('returns "No dead code found." when all symbols are referenced', () => {
    const p = upsertProject(db, 'clean-app', '/clean');
    const f = upsertFile(db, p.id, 'src/Clean.java', 'h');
    const callerSrc = insertSymbol(db, { file_id: f.id, name: 'caller', kind: 'method', start_line: 1, end_line: 5 });
    const calleeTgt = insertSymbol(db, { file_id: f.id, name: 'callee', kind: 'method', start_line: 6, end_line: 10 });
    // caller references callee; external code references caller
    insertRef(db, callerSrc, calleeTgt, 'call');
    insertRef(db, null, callerSrc, 'call');

    const result = deadCodeAction(db, 'clean-app');

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('No dead code found');
  });

  // Cycle 7
  it('returns "No dead code found." when no projects are indexed', () => {
    const result = deadCodeAction(db);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('No dead code found');
  });
});
