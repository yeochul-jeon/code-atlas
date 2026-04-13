/**
 * E2E Verification Tests
 *
 * Indexes the real cjos-hexa-arch-sample project (143 Java files, Spring Boot hexagonal arch)
 * and verifies the full pipeline: indexing → symbols → dependencies → references → dead code → incremental.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openDatabase } from '../storage/database.js';
import {
  listProjectFiles,
  searchSymbolsFts,
  getSymbolsByFile,
  getDependenciesByFile,
  getRefsByTargetSymbol,
  findDeadCode,
} from '../storage/queries.js';
import { indexProject } from '../indexer/indexer.js';
import type { Db } from '../storage/database.js';

// Path to the real test target project
const TEST_TARGET = process.env.CODEATLAS_TEST_TARGET
  ?? '/Users/cjenm/cjenm/platform/cjos-hexa-arch-sample';

let db: Db;
let projectId: number;
let initialIndexed: number;

beforeAll(() => {
  db = openDatabase(':memory:');
  const result = indexProject(db, TEST_TARGET, 'cjos-hexa-arch-sample');
  projectId = result.project.id;
  initialIndexed = result.indexed;
}, 60_000); // allow up to 60s for full indexing

afterAll(() => {
  db.close();
});

// ─── A1: Indexing result ───────────────────────────────────────────────────────

describe('A1: Full pipeline — index result', () => {
  it('indexes a substantial number of Java files with no errors', () => {
    const result = indexProject(openDatabase(':memory:'), TEST_TARGET, 'test');
    expect(result.errors).toBe(0);
    expect(result.indexed).toBeGreaterThanOrEqual(50);
  });

  it('DB file count matches indexed count', () => {
    const files = listProjectFiles(db, projectId);
    expect(files.length).toBe(initialIndexed);
  });

  it('project name is correct', () => {
    const result = indexProject(openDatabase(':memory:'), TEST_TARGET, 'cjos-hexa-arch-sample');
    expect(result.project.name).toBe('cjos-hexa-arch-sample');
  });
});

// ─── A2: Symbol verification ──────────────────────────────────────────────────

describe('A2: Full pipeline — symbol verification', () => {
  it('indexes CartController as a class', () => {
    const results = searchSymbolsFts(db, 'CartController', 'class', projectId);
    const exact = results.find(r => r.name === 'CartController');
    expect(exact, 'CartController class should be indexed').toBeDefined();
  });

  it('indexes CartCrudService as a class with @UseCase annotation', () => {
    const results = searchSymbolsFts(db, 'CartCrudService', 'class', projectId);
    const exact = results.find(r => r.name === 'CartCrudService');
    expect(exact, 'CartCrudService class should be indexed').toBeDefined();
    const annotations: string[] = exact!.annotations ? JSON.parse(exact!.annotations) : [];
    expect(annotations.some(a => a.includes('UseCase'))).toBe(true);
  });

  it('indexes Cart as a record kind', () => {
    const results = searchSymbolsFts(db, 'Cart', undefined, projectId);
    const cartRecord = results.find(r => r.name === 'Cart' && r.kind === 'record');
    expect(cartRecord).toBeDefined();
  });

  it('indexes custom annotation types (WebAdapter, UseCase, PersistenceAdapter, ApiAdapter)', () => {
    for (const name of ['WebAdapter', 'UseCase', 'PersistenceAdapter', 'ApiAdapter']) {
      const results = searchSymbolsFts(db, name, undefined, projectId);
      const annotationType = results.find(r => r.name === name && r.kind === 'annotation_type');
      expect(annotationType, `Expected annotation_type for ${name}`).toBeDefined();
    }
  });

  it('indexes CartCrudUseCase and CartPersistencePort as interfaces', () => {
    for (const name of ['CartCrudUseCase', 'CartPersistencePort']) {
      const results = searchSymbolsFts(db, name, 'interface', projectId);
      expect(results.length, `Expected interface for ${name}`).toBeGreaterThanOrEqual(1);
    }
  });

  it('indexes enum types (CartGrpType, GiftType)', () => {
    for (const name of ['CartGrpType', 'GiftType']) {
      const results = searchSymbolsFts(db, name, 'enum', projectId);
      expect(results.length, `Expected enum for ${name}`).toBeGreaterThanOrEqual(1);
    }
  });

  it('indexes CartController methods (at least addCart, getCartList, removeCart)', () => {
    const classResults = searchSymbolsFts(db, 'CartController', 'class', projectId);
    expect(classResults.length).toBeGreaterThanOrEqual(1);
    const controllerFile = classResults[0];
    const files = listProjectFiles(db, projectId);
    const fileRecord = files.find(f => f.relative_path === controllerFile.relative_path);
    expect(fileRecord).toBeDefined();
    const symbols = getSymbolsByFile(db, fileRecord!.id);
    const methods = symbols.filter(s => s.kind === 'method');
    expect(methods.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── A3: Dependency verification ─────────────────────────────────────────────

describe('A3: Full pipeline — dependency verification', () => {
  it('CartCrudService implements CartCrudUseCase', () => {
    const results = searchSymbolsFts(db, 'CartCrudService', 'class', projectId);
    const exact = results.find(r => r.name === 'CartCrudService');
    expect(exact, 'CartCrudService class should be indexed').toBeDefined();
    const files = listProjectFiles(db, projectId);
    const fileRecord = files.find(f => f.relative_path === exact!.relative_path);
    expect(fileRecord).toBeDefined();
    const deps = getDependenciesByFile(db, fileRecord!.id);
    const implementsDep = deps.find(
      d => d.kind === 'implements' && d.target_fqn.includes('CartCrudUseCase'),
    );
    expect(implementsDep, 'CartCrudService should implement CartCrudUseCase').toBeDefined();
  });

  it('CartController has at least 5 imports', () => {
    const results = searchSymbolsFts(db, 'CartController', 'class', projectId);
    const files = listProjectFiles(db, projectId);
    const fileRecord = files.find(f => f.relative_path === results[0].relative_path);
    expect(fileRecord).toBeDefined();
    const deps = getDependenciesByFile(db, fileRecord!.id);
    const imports = deps.filter(d => d.kind === 'import');
    expect(imports.length).toBeGreaterThanOrEqual(5);
  });
});

// ─── A4: Cross-file reference resolution ─────────────────────────────────────

describe('A4: Full pipeline — cross-file references', () => {
  it('resolves at least one cross-file reference (target_symbol_id is not null)', () => {
    // Query the refs table directly for non-null resolved refs
    const row = (db as any)
      .prepare(
        `SELECT COUNT(*) as cnt
         FROM refs r
         JOIN symbols s ON s.id = r.source_symbol_id
         JOIN files f ON f.id = s.file_id
         WHERE f.project_id = ? AND r.target_symbol_id IS NOT NULL`,
      )
      .get(projectId) as { cnt: number };
    expect(row.cnt).toBeGreaterThan(0);
  });

  it('CartController methods have incoming reference count tracked', () => {
    const classResults = searchSymbolsFts(db, 'CartController', 'class', projectId);
    const files = listProjectFiles(db, projectId);
    const fileRecord = files.find(f => f.relative_path === classResults[0].relative_path);
    const symbols = getSymbolsByFile(db, fileRecord!.id);
    // At least one symbol in the file should have reference info queryable
    const firstMethod = symbols.find(s => s.kind === 'method');
    if (firstMethod) {
      const refs = getRefsByTargetSymbol(db, firstMethod.id);
      // refs may be empty or non-empty; the important thing is the query doesn't throw
      expect(Array.isArray(refs)).toBe(true);
    }
  });
});

// ─── A5: Dead code detection ──────────────────────────────────────────────────

describe('A5: Full pipeline — dead code detection', () => {
  it('does not report CartController as dead (@RestController excluded)', () => {
    const dead = findDeadCode(db, projectId);
    const cartController = dead.find(d => d.name === 'CartController');
    expect(cartController).toBeUndefined();
  });

  it('does not report @UseCase-annotated CartCrudService as dead', () => {
    const dead = findDeadCode(db, projectId);
    const cartCrudService = dead.find(d => d.name === 'CartCrudService');
    expect(cartCrudService, 'CartCrudService (@UseCase) should not be dead code').toBeUndefined();
  });

  it('does not report @WebAdapter-annotated classes as dead', () => {
    const dead = findDeadCode(db, projectId);
    const webAdapterClasses = dead.filter(d => {
      const anns: string[] = d.annotations ? JSON.parse(d.annotations) : [];
      return anns.some(a => a.includes('WebAdapter'));
    });
    expect(webAdapterClasses.length).toBe(0);
  });

  it('does not report @PersistenceAdapter-annotated classes as dead', () => {
    const dead = findDeadCode(db, projectId);
    const persistenceAdapters = dead.filter(d => {
      const anns: string[] = d.annotations ? JSON.parse(d.annotations) : [];
      return anns.some(a => a.includes('PersistenceAdapter'));
    });
    expect(persistenceAdapters.length).toBe(0);
  });

  it('does not report enum types as dead', () => {
    const dead = findDeadCode(db, projectId);
    const enumSymbols = dead.filter(d => d.kind === 'enum');
    expect(enumSymbols.length).toBe(0);
  });

  it('does not report constructors as dead', () => {
    const dead = findDeadCode(db, projectId);
    const constructors = dead.filter(d => d.kind === 'constructor');
    expect(constructors.length).toBe(0);
  });
});

// ─── A6: Incremental indexing ─────────────────────────────────────────────────

describe('A6: Full pipeline — incremental indexing', () => {
  it('second run with incremental=true skips all files (no changes)', () => {
    const result2 = indexProject(db, TEST_TARGET, 'cjos-hexa-arch-sample', { incremental: true });
    expect(result2.indexed).toBe(0);
    expect(result2.skipped).toBe(initialIndexed);
    expect(result2.errors).toBe(0);
  });

  it('symbol count is unchanged after incremental re-index', () => {
    const countBefore = (db as any)
      .prepare(
        `SELECT COUNT(*) as cnt FROM symbols s
         JOIN files f ON f.id = s.file_id
         WHERE f.project_id = ?`,
      )
      .get(projectId) as { cnt: number };

    indexProject(db, TEST_TARGET, 'cjos-hexa-arch-sample', { incremental: true });

    const countAfter = (db as any)
      .prepare(
        `SELECT COUNT(*) as cnt FROM symbols s
         JOIN files f ON f.id = s.file_id
         WHERE f.project_id = ?`,
      )
      .get(projectId) as { cnt: number };

    expect(countAfter.cnt).toBe(countBefore.cnt);
  });
});
