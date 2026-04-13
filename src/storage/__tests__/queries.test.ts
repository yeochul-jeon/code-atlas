import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, type Db } from '../database.js';
import {
  upsertProject,
  touchProjectIndexed,
  listProjects,
  getProjectById,
  deleteProject,
  upsertFile,
  getFile,
  listProjectFiles,
  deleteFileData,
  insertSymbol,
  getSymbolsByFile,
  getSymbolById,
  searchSymbolsFts,
  insertDependency,
  getDependenciesByFile,
  insertRef,
  getRefsByTargetSymbol,
  upsertSummary,
  getSummaryForFile,
  getStats,
  findDeadCode,
} from '../queries.js';

let db: Db;

beforeEach(() => {
  db = openDatabase(':memory:');
});

afterEach(() => {
  db.close();
});

// ─── Projects ────────────────────────────────────────────────────────────────

describe('Projects', () => {
  it('upsertProject creates a new project', () => {
    const p = upsertProject(db, 'my-project', '/path/to/project');
    expect(p.name).toBe('my-project');
    expect(p.root_path).toBe('/path/to/project');
    expect(p.id).toBeTypeOf('number');
  });

  it('upsertProject updates name on conflict (same root_path)', () => {
    upsertProject(db, 'old-name', '/path/to/project');
    const p = upsertProject(db, 'new-name', '/path/to/project');
    expect(p.name).toBe('new-name');
    const all = listProjects(db);
    expect(all).toHaveLength(1);
  });

  it('listProjects returns all projects sorted by name', () => {
    upsertProject(db, 'z-project', '/z');
    upsertProject(db, 'a-project', '/a');
    const list = listProjects(db);
    expect(list.map(p => p.name)).toEqual(['a-project', 'z-project']);
  });

  it('getProjectById returns correct project', () => {
    const created = upsertProject(db, 'test', '/test');
    const found = getProjectById(db, created.id);
    expect(found?.name).toBe('test');
  });

  it('getProjectById returns undefined for unknown id', () => {
    expect(getProjectById(db, 9999)).toBeUndefined();
  });

  it('touchProjectIndexed sets last_indexed_at', () => {
    const p = upsertProject(db, 'test', '/test');
    expect(p.last_indexed_at).toBeNull();
    touchProjectIndexed(db, p.id);
    const updated = getProjectById(db, p.id);
    expect(updated?.last_indexed_at).toBeTypeOf('string');
  });

  it('deleteProject removes the project', () => {
    const p = upsertProject(db, 'test', '/test');
    deleteProject(db, p.id);
    expect(getProjectById(db, p.id)).toBeUndefined();
    expect(listProjects(db)).toHaveLength(0);
  });
});

// ─── Files ───────────────────────────────────────────────────────────────────

describe('Files', () => {
  let projectId: number;

  beforeEach(() => {
    const p = upsertProject(db, 'proj', '/root');
    projectId = p.id;
  });

  it('upsertFile creates a file record', () => {
    const f = upsertFile(db, projectId, 'src/Foo.java', 'abc123');
    expect(f.relative_path).toBe('src/Foo.java');
    expect(f.content_hash).toBe('abc123');
  });

  it('upsertFile updates hash on re-insert', () => {
    upsertFile(db, projectId, 'src/Foo.java', 'old-hash');
    const f = upsertFile(db, projectId, 'src/Foo.java', 'new-hash');
    expect(f.content_hash).toBe('new-hash');
    expect(listProjectFiles(db, projectId)).toHaveLength(1);
  });

  it('getFile returns the file record', () => {
    upsertFile(db, projectId, 'src/Bar.java', 'hashxyz');
    const f = getFile(db, projectId, 'src/Bar.java');
    expect(f?.content_hash).toBe('hashxyz');
  });

  it('getFile returns undefined for unknown path', () => {
    expect(getFile(db, projectId, 'nonexistent.java')).toBeUndefined();
  });

  it('listProjectFiles returns all files for a project', () => {
    upsertFile(db, projectId, 'A.java', 'h1');
    upsertFile(db, projectId, 'B.java', 'h2');
    expect(listProjectFiles(db, projectId)).toHaveLength(2);
  });

  it('deleteFileData removes symbols and deps for a file', () => {
    const f = upsertFile(db, projectId, 'X.java', 'h');
    insertSymbol(db, { file_id: f.id, name: 'X', kind: 'class', start_line: 1, end_line: 10 });
    insertDependency(db, f.id, 'java.util.List', 'import');
    deleteFileData(db, f.id);
    expect(getSymbolsByFile(db, f.id)).toHaveLength(0);
    expect(getDependenciesByFile(db, f.id)).toHaveLength(0);
  });
});

// ─── Symbols ─────────────────────────────────────────────────────────────────

describe('Symbols', () => {
  let fileId: number;

  beforeEach(() => {
    const p = upsertProject(db, 'proj', '/root');
    const f = upsertFile(db, p.id, 'src/Foo.java', 'h');
    fileId = f.id;
  });

  it('insertSymbol returns a numeric id', () => {
    const id = insertSymbol(db, {
      file_id: fileId,
      name: 'Foo',
      kind: 'class',
      start_line: 1,
      end_line: 20,
    });
    expect(id).toBeTypeOf('number');
    expect(id).toBeGreaterThan(0);
  });

  it('insertSymbol stores modifiers and annotations as JSON', () => {
    insertSymbol(db, {
      file_id: fileId,
      name: 'Foo',
      kind: 'class',
      start_line: 1,
      end_line: 20,
      modifiers: ['public', 'final'],
      annotations: ['@Service'],
    });
    const [sym] = getSymbolsByFile(db, fileId);
    expect(JSON.parse(sym.modifiers!)).toEqual(['public', 'final']);
    expect(JSON.parse(sym.annotations!)).toEqual(['@Service']);
  });

  it('getSymbolsByFile returns symbols ordered by start_line', () => {
    insertSymbol(db, { file_id: fileId, name: 'B', kind: 'method', start_line: 10, end_line: 15 });
    insertSymbol(db, { file_id: fileId, name: 'A', kind: 'method', start_line: 5, end_line: 9 });
    const syms = getSymbolsByFile(db, fileId);
    expect(syms[0].name).toBe('A');
    expect(syms[1].name).toBe('B');
  });

  it('getSymbolById returns the correct symbol', () => {
    const id = insertSymbol(db, { file_id: fileId, name: 'Foo', kind: 'class', start_line: 1, end_line: 5 });
    const sym = getSymbolById(db, id);
    expect(sym?.name).toBe('Foo');
  });

  it('insertSymbol respects parent_id', () => {
    const parentId = insertSymbol(db, { file_id: fileId, name: 'Outer', kind: 'class', start_line: 1, end_line: 20 });
    const childId = insertSymbol(db, { file_id: fileId, name: 'inner', kind: 'method', start_line: 5, end_line: 10, parent_id: parentId });
    const child = getSymbolById(db, childId);
    expect(child?.parent_id).toBe(parentId);
  });
});

// ─── FTS Search ──────────────────────────────────────────────────────────────

describe('searchSymbolsFts', () => {
  let fileId: number;
  let projectId: number;

  beforeEach(() => {
    const p = upsertProject(db, 'proj', '/root');
    projectId = p.id;
    const f = upsertFile(db, p.id, 'src/CartService.java', 'h');
    fileId = f.id;
    insertSymbol(db, { file_id: fileId, name: 'CartService', kind: 'class', start_line: 1, end_line: 50 });
    insertSymbol(db, { file_id: fileId, name: 'addItem', kind: 'method', start_line: 10, end_line: 20 });
    insertSymbol(db, { file_id: fileId, name: 'removeItem', kind: 'method', start_line: 22, end_line: 30 });
  });

  it('finds symbol by prefix', () => {
    const results = searchSymbolsFts(db, 'Cart');
    expect(results.some(r => r.name === 'CartService')).toBe(true);
  });

  it('finds symbol by LIKE fallback (substring)', () => {
    const results = searchSymbolsFts(db, 'remove');
    expect(results.some(r => r.name === 'removeItem')).toBe(true);
  });

  it('filters by kind', () => {
    const results = searchSymbolsFts(db, 'addItem', 'class');
    expect(results).toHaveLength(0);
    const results2 = searchSymbolsFts(db, 'addItem', 'method');
    expect(results2.some(r => r.name === 'addItem')).toBe(true);
  });

  it('filters by projectId', () => {
    const results = searchSymbolsFts(db, 'CartService', undefined, projectId);
    expect(results.some(r => r.name === 'CartService')).toBe(true);
    const results2 = searchSymbolsFts(db, 'CartService', undefined, 9999);
    expect(results2).toHaveLength(0);
  });

  it('includes file path and project name in results', () => {
    const results = searchSymbolsFts(db, 'Cart');
    expect(results[0].relative_path).toBe('src/CartService.java');
    expect(results[0].project_name).toBe('proj');
  });
});

// ─── Dependencies ─────────────────────────────────────────────────────────────

describe('Dependencies', () => {
  let fileId: number;

  beforeEach(() => {
    const p = upsertProject(db, 'proj', '/root');
    const f = upsertFile(db, p.id, 'src/Foo.java', 'h');
    fileId = f.id;
  });

  it('insertDependency and getDependenciesByFile', () => {
    insertDependency(db, fileId, 'java.util.List', 'import');
    insertDependency(db, fileId, 'com.example.Base', 'extends');
    const deps = getDependenciesByFile(db, fileId);
    expect(deps).toHaveLength(2);
    expect(deps.map(d => d.kind).sort()).toEqual(['extends', 'import']);
  });
});

// ─── References ──────────────────────────────────────────────────────────────

describe('References', () => {
  let fileId: number;

  beforeEach(() => {
    const p = upsertProject(db, 'proj', '/root');
    const f = upsertFile(db, p.id, 'src/Foo.java', 'h');
    fileId = f.id;
  });

  it('insertRef with null IDs stores a ref', () => {
    insertRef(db, null, null, 'call');
    const all = db.prepare('SELECT * FROM refs').all() as { kind: string }[];
    expect(all).toHaveLength(1);
    expect(all[0].kind).toBe('call');
  });

  it('insertRef with symbol IDs and getRefsByTargetSymbol', () => {
    const srcId = insertSymbol(db, { file_id: fileId, name: 'caller', kind: 'method', start_line: 1, end_line: 5 });
    const tgtId = insertSymbol(db, { file_id: fileId, name: 'callee', kind: 'method', start_line: 10, end_line: 15 });
    insertRef(db, srcId, tgtId, 'call');
    const refs = getRefsByTargetSymbol(db, tgtId);
    expect(refs).toHaveLength(1);
    expect(refs[0].source_symbol_id).toBe(srcId);
    expect(refs[0].kind).toBe('call');
  });
});

// ─── Summaries ────────────────────────────────────────────────────────────────

describe('Summaries', () => {
  let fileId: number;

  beforeEach(() => {
    const p = upsertProject(db, 'proj', '/root');
    const f = upsertFile(db, p.id, 'src/Foo.java', 'h');
    fileId = f.id;
  });

  it('upsertSummary and getSummaryForFile', () => {
    upsertSummary(db, fileId, null, 'This is a summary', 'claude-sonnet-4-6');
    const s = getSummaryForFile(db, fileId);
    expect(s?.content).toBe('This is a summary');
    expect(s?.model_version).toBe('claude-sonnet-4-6');
  });

  it('upsertSummary updates existing summary', () => {
    upsertSummary(db, fileId, null, 'old content', 'v1');
    upsertSummary(db, fileId, null, 'new content', 'v2');
    const s = getSummaryForFile(db, fileId);
    expect(s?.content).toBe('new content');
  });
});

// ─── Stats ────────────────────────────────────────────────────────────────────

// ─── Dead Code Detection ──────────────────────────────────────────────────────

describe('findDeadCode', () => {
  let projectId: number;
  let fileId: number;

  beforeEach(() => {
    const p = upsertProject(db, 'proj', '/root');
    projectId = p.id;
    const f = upsertFile(db, p.id, 'src/Foo.java', 'h');
    fileId = f.id;
  });

  it('returns unreferenced methods as dead code', () => {
    // A method with no incoming refs → dead
    insertSymbol(db, { file_id: fileId, name: 'unusedMethod', kind: 'method', start_line: 5, end_line: 10 });
    const dead = findDeadCode(db, projectId);
    expect(dead.some(s => s.name === 'unusedMethod')).toBe(true);
  });

  it('does not report referenced methods as dead', () => {
    const srcId = insertSymbol(db, { file_id: fileId, name: 'caller', kind: 'method', start_line: 1, end_line: 5 });
    const tgtId = insertSymbol(db, { file_id: fileId, name: 'callee', kind: 'method', start_line: 6, end_line: 10 });
    insertRef(db, srcId, tgtId, 'call');
    const dead = findDeadCode(db, projectId);
    expect(dead.some(s => s.name === 'callee')).toBe(false);
  });

  it('excludes @Service annotated classes', () => {
    insertSymbol(db, {
      file_id: fileId, name: 'MyService', kind: 'class',
      start_line: 1, end_line: 50,
      annotations: ['@Service'],
    });
    const dead = findDeadCode(db, projectId);
    expect(dead.some(s => s.name === 'MyService')).toBe(false);
  });

  it('excludes @RestController annotated classes', () => {
    insertSymbol(db, {
      file_id: fileId, name: 'UserController', kind: 'class',
      start_line: 1, end_line: 50,
      annotations: ['@RestController'],
    });
    const dead = findDeadCode(db, projectId);
    expect(dead.some(s => s.name === 'UserController')).toBe(false);
  });

  it('excludes @Component annotated classes', () => {
    insertSymbol(db, {
      file_id: fileId, name: 'MyComponent', kind: 'class',
      start_line: 1, end_line: 20,
      annotations: ['@Component'],
    });
    const dead = findDeadCode(db, projectId);
    expect(dead.some(s => s.name === 'MyComponent')).toBe(false);
  });

  it('excludes @Repository annotated classes', () => {
    insertSymbol(db, {
      file_id: fileId, name: 'MyRepo', kind: 'class',
      start_line: 1, end_line: 20,
      annotations: ['@Repository'],
    });
    const dead = findDeadCode(db, projectId);
    expect(dead.some(s => s.name === 'MyRepo')).toBe(false);
  });

  it('excludes @Override methods', () => {
    insertSymbol(db, {
      file_id: fileId, name: 'toString', kind: 'method',
      start_line: 5, end_line: 7,
      annotations: ['@Override'],
    });
    const dead = findDeadCode(db, projectId);
    expect(dead.some(s => s.name === 'toString')).toBe(false);
  });

  it('excludes @Bean methods', () => {
    insertSymbol(db, {
      file_id: fileId, name: 'dataSource', kind: 'method',
      start_line: 5, end_line: 10,
      annotations: ['@Bean'],
    });
    const dead = findDeadCode(db, projectId);
    expect(dead.some(s => s.name === 'dataSource')).toBe(false);
  });

  it('excludes main() entry point', () => {
    insertSymbol(db, {
      file_id: fileId, name: 'main', kind: 'method',
      start_line: 1, end_line: 5,
    });
    const dead = findDeadCode(db, projectId);
    expect(dead.some(s => s.name === 'main')).toBe(false);
  });

  it('excludes public static final fields (constants)', () => {
    insertSymbol(db, {
      file_id: fileId, name: 'MAX_SIZE', kind: 'field',
      start_line: 3, end_line: 3,
      modifiers: ['public', 'static', 'final'],
    });
    const dead = findDeadCode(db, projectId);
    expect(dead.some(s => s.name === 'MAX_SIZE')).toBe(false);
  });

  it('excludes constructors from dead code', () => {
    insertSymbol(db, {
      file_id: fileId, name: 'Foo', kind: 'constructor',
      start_line: 2, end_line: 5,
    });
    const dead = findDeadCode(db, projectId);
    expect(dead.some(s => s.name === 'Foo')).toBe(false);
  });

  it('filters by kind when provided', () => {
    insertSymbol(db, { file_id: fileId, name: 'unusedField', kind: 'field', start_line: 1, end_line: 1 });
    insertSymbol(db, { file_id: fileId, name: 'unusedMethod', kind: 'method', start_line: 3, end_line: 8 });
    const dead = findDeadCode(db, projectId, 'method');
    expect(dead.some(s => s.name === 'unusedMethod')).toBe(true);
    expect(dead.some(s => s.name === 'unusedField')).toBe(false);
  });

  it('returns empty array when all symbols are referenced or excluded', () => {
    const srcId = insertSymbol(db, { file_id: fileId, name: 'a', kind: 'method', start_line: 1, end_line: 5 });
    const tgtId = insertSymbol(db, { file_id: fileId, name: 'b', kind: 'method', start_line: 6, end_line: 10 });
    insertRef(db, srcId, tgtId, 'call');
    insertSymbol(db, { file_id: fileId, name: 'main', kind: 'method', start_line: 11, end_line: 15 });
    const dead = findDeadCode(db, projectId);
    // 'a' is unreferenced but 'b' and 'main' are excluded/referenced
    // 'a' itself has no incoming refs → should be dead
    expect(dead.some(s => s.name === 'b')).toBe(false);
    expect(dead.some(s => s.name === 'main')).toBe(false);
  });
});

describe('getStats', () => {
  it('returns zero counts on empty DB', () => {
    const stats = getStats(db);
    expect(stats.projects).toBe(0);
    expect(stats.files).toBe(0);
    expect(stats.symbols).toBe(0);
    expect(stats.dependencies).toBe(0);
  });

  it('returns correct counts after inserts', () => {
    const p = upsertProject(db, 'proj', '/root');
    const f = upsertFile(db, p.id, 'src/Foo.java', 'h');
    insertSymbol(db, { file_id: f.id, name: 'Foo', kind: 'class', start_line: 1, end_line: 10 });
    insertDependency(db, f.id, 'java.util.List', 'import');
    const stats = getStats(db);
    expect(stats.projects).toBe(1);
    expect(stats.files).toBe(1);
    expect(stats.symbols).toBe(1);
    expect(stats.dependencies).toBe(1);
  });
});
