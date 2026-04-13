/**
 * MCP server tool handler tests.
 *
 * We extract tool handler logic into a separate testable layer (formatDeadCode)
 * so we don't need to spin up the stdio transport for unit testing.
 *
 * For now, we test the query-layer integration that the server depends on:
 * findDeadCode returns results and formatDeadCodeResult formats them correctly.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, type Db } from '../../storage/database.js';
import {
  upsertProject,
  upsertFile,
  insertSymbol,
  insertRef,
  findDeadCode,
} from '../../storage/queries.js';
import { formatDeadCodeResult } from '../dead-code-formatter.js';

let db: Db;
let projectId: number;
let fileId: number;

beforeEach(() => {
  db = openDatabase(':memory:');
  const p = upsertProject(db, 'my-project', '/root');
  projectId = p.id;
  const f = upsertFile(db, p.id, 'src/MyClass.java', 'h');
  fileId = f.id;
});

afterEach(() => {
  db.close();
});

describe('formatDeadCodeResult', () => {
  it('returns "No dead code found" when all methods are excluded or referenced', () => {
    // main() is always excluded, and callee has an incoming ref
    insertSymbol(db, { file_id: fileId, name: 'main', kind: 'method', start_line: 1, end_line: 3 });
    const tgtId = insertSymbol(db, { file_id: fileId, name: 'callee', kind: 'method', start_line: 6, end_line: 10 });
    // Use a dummy ref source (null = external caller) so callee is referenced
    insertRef(db, null, tgtId, 'call');
    const dead = findDeadCode(db, projectId);
    const text = formatDeadCodeResult(dead);
    expect(text).toContain('No dead code found');
  });

  it('formats a dead method entry with file path and line number', () => {
    insertSymbol(db, {
      file_id: fileId, name: 'orphanMethod', kind: 'method',
      start_line: 42, end_line: 50,
      signature: 'void orphanMethod()',
    });
    const dead = findDeadCode(db, projectId);
    const text = formatDeadCodeResult(dead);
    expect(text).toContain('orphanMethod');
    expect(text).toContain('method');
    expect(text).toContain('L42');
    expect(text).toContain('src/MyClass.java');
  });

  it('shows count of dead symbols', () => {
    insertSymbol(db, { file_id: fileId, name: 'a', kind: 'method', start_line: 1, end_line: 5 });
    insertSymbol(db, { file_id: fileId, name: 'b', kind: 'method', start_line: 6, end_line: 10 });
    const dead = findDeadCode(db, projectId);
    const text = formatDeadCodeResult(dead);
    expect(text).toContain('2');
  });

  it('excludes Spring-annotated symbols from dead code output', () => {
    insertSymbol(db, {
      file_id: fileId, name: 'MyService', kind: 'class',
      start_line: 1, end_line: 100,
      annotations: ['@Service'],
    });
    const dead = findDeadCode(db, projectId);
    const text = formatDeadCodeResult(dead);
    expect(text).toContain('No dead code found');
  });
});
