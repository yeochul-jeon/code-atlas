import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { openDatabase, type Db } from '../../storage/database.js';
import { listProjectFiles, getSymbolsByFile, getDependenciesByFile, getRefsByTargetSymbol, findDeadCode } from '../../storage/queries.js';
import { indexProject } from '../indexer.js';

const SIMPLE_JAVA = `
import java.util.List;

public class Cart {
  private int count;

  public Cart() {}

  public void addItem(String item) {
    helper();
  }

  private void helper() {}
}
`.trim();

let db: Db;
let tmpDir: string;

beforeEach(() => {
  db = openDatabase(':memory:');
  tmpDir = mkdtempSync(join(tmpdir(), 'codeatlas-test-'));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Basic indexing ───────────────────────────────────────────────────────────

describe('indexProject — basic', () => {
  it('returns an IndexResult with project info', () => {
    writeFileSync(join(tmpDir, 'Cart.java'), SIMPLE_JAVA);
    const result = indexProject(db, tmpDir, 'my-project');
    expect(result.project.name).toBe('my-project');
    expect(result.project.id).toBeTypeOf('number');
  });

  it('indexes .java files and counts them', () => {
    writeFileSync(join(tmpDir, 'A.java'), SIMPLE_JAVA);
    writeFileSync(join(tmpDir, 'B.java'), SIMPLE_JAVA);
    const result = indexProject(db, tmpDir, 'proj');
    expect(result.indexed).toBe(2);
    expect(result.errors).toBe(0);
  });

  it('persists file records in the database', () => {
    writeFileSync(join(tmpDir, 'Cart.java'), SIMPLE_JAVA);
    const result = indexProject(db, tmpDir, 'proj');
    const files = listProjectFiles(db, result.project.id);
    expect(files).toHaveLength(1);
    expect(files[0].relative_path).toBe('Cart.java');
    expect(files[0].content_hash).toBeTruthy();
  });

  it('extracts symbols into the database', () => {
    writeFileSync(join(tmpDir, 'Cart.java'), SIMPLE_JAVA);
    const result = indexProject(db, tmpDir, 'proj');
    const files = listProjectFiles(db, result.project.id);
    const symbols = getSymbolsByFile(db, files[0].id);
    const names = symbols.map(s => s.name);
    expect(names).toContain('Cart');
    expect(names).toContain('addItem');
    expect(names).toContain('helper');
    expect(names).toContain('count');
  });

  it('extracts dependencies into the database', () => {
    writeFileSync(join(tmpDir, 'Cart.java'), SIMPLE_JAVA);
    const result = indexProject(db, tmpDir, 'proj');
    const files = listProjectFiles(db, result.project.id);
    const deps = getDependenciesByFile(db, files[0].id);
    expect(deps.some(d => d.target_fqn === 'java.util.List' && d.kind === 'import')).toBe(true);
  });

  it('records durationMs', () => {
    const result = indexProject(db, tmpDir, 'proj');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ─── Ignored paths ────────────────────────────────────────────────────────────

describe('indexProject — ignored paths', () => {
  it('ignores non-Java files', () => {
    writeFileSync(join(tmpDir, 'readme.txt'), 'hello');
    writeFileSync(join(tmpDir, 'build.gradle'), 'plugins {}');
    const result = indexProject(db, tmpDir, 'proj');
    expect(result.indexed).toBe(0);
    expect(listProjectFiles(db, result.project.id)).toHaveLength(0);
  });

  it('ignores build directory', () => {
    mkdirSync(join(tmpDir, 'build'));
    writeFileSync(join(tmpDir, 'build', 'Hidden.java'), SIMPLE_JAVA);
    const result = indexProject(db, tmpDir, 'proj');
    expect(result.indexed).toBe(0);
  });

  it('ignores node_modules directory', () => {
    mkdirSync(join(tmpDir, 'node_modules'));
    writeFileSync(join(tmpDir, 'node_modules', 'Hidden.java'), SIMPLE_JAVA);
    const result = indexProject(db, tmpDir, 'proj');
    expect(result.indexed).toBe(0);
  });

  it('ignores out directory', () => {
    mkdirSync(join(tmpDir, 'out'));
    writeFileSync(join(tmpDir, 'out', 'Hidden.java'), SIMPLE_JAVA);
    const result = indexProject(db, tmpDir, 'proj');
    expect(result.indexed).toBe(0);
  });

  it('ignores hidden directories', () => {
    mkdirSync(join(tmpDir, '.git'));
    writeFileSync(join(tmpDir, '.git', 'COMMIT_EDITMSG'), '');
    writeFileSync(join(tmpDir, '.git', 'Hidden.java'), SIMPLE_JAVA);
    const result = indexProject(db, tmpDir, 'proj');
    expect(result.indexed).toBe(0);
  });
});

// ─── Incremental indexing ────────────────────────────────────────────────────

describe('indexProject — incremental', () => {
  it('skips unchanged files when incremental=true', () => {
    writeFileSync(join(tmpDir, 'Cart.java'), SIMPLE_JAVA);
    indexProject(db, tmpDir, 'proj');

    const result2 = indexProject(db, tmpDir, 'proj', { incremental: true });
    expect(result2.skipped).toBe(1);
    expect(result2.indexed).toBe(0);
  });

  it('re-indexes changed files even when incremental=true', () => {
    writeFileSync(join(tmpDir, 'Cart.java'), SIMPLE_JAVA);
    indexProject(db, tmpDir, 'proj');

    writeFileSync(join(tmpDir, 'Cart.java'), SIMPLE_JAVA + '\n// changed');
    const result2 = indexProject(db, tmpDir, 'proj', { incremental: true });
    expect(result2.indexed).toBe(1);
    expect(result2.skipped).toBe(0);
  });

  it('full re-index (incremental=false) always re-indexes', () => {
    writeFileSync(join(tmpDir, 'Cart.java'), SIMPLE_JAVA);
    indexProject(db, tmpDir, 'proj');

    const result2 = indexProject(db, tmpDir, 'proj', { incremental: false });
    expect(result2.indexed).toBe(1);
    expect(result2.skipped).toBe(0);
  });
});

// ─── Symbol ID mapping ────────────────────────────────────────────────────────

describe('indexProject — symbol parent IDs', () => {
  it('correctly maps parent IDs to DB IDs', () => {
    writeFileSync(join(tmpDir, 'Cart.java'), SIMPLE_JAVA);
    const result = indexProject(db, tmpDir, 'proj');
    const files = listProjectFiles(db, result.project.id);
    const symbols = getSymbolsByFile(db, files[0].id);

    const cart = symbols.find(s => s.name === 'Cart' && s.kind === 'class');
    const method = symbols.find(s => s.name === 'addItem');
    expect(cart).toBeDefined();
    expect(method).toBeDefined();
    expect(method!.parent_id).toBe(cart!.id);
  });
});

// ─── Cross-file reference resolution ─────────────────────────────────────────

describe('indexProject — cross-file reference resolution', () => {
  // File A defines CartService with method process()
  // File B defines OrderService which calls cartService.process()
  // After indexing both, process() should have an incoming ref from OrderService

  const CART_SERVICE = `
public class CartService {
  public void process() {}
  public void clear() {}
}
`.trim();

  const ORDER_SERVICE = `
public class OrderService {
  private CartService cartService;

  public void submitOrder() {
    cartService.process();
  }
}
`.trim();

  it('records same-file method call references', () => {
    writeFileSync(join(tmpDir, 'CartService.java'), CART_SERVICE);
    const result = indexProject(db, tmpDir, 'proj');
    const files = listProjectFiles(db, result.project.id);
    const cartFile = files.find(f => f.relative_path === 'CartService.java')!;
    const symbols = getSymbolsByFile(db, cartFile.id);
    // process() is defined but never called within CartService → dead
    const dead = findDeadCode(db, result.project.id, 'method');
    expect(dead.some(s => s.name === 'process')).toBe(true);
  });

  it('links cross-file call reference to target symbol after indexing both files', () => {
    writeFileSync(join(tmpDir, 'CartService.java'), CART_SERVICE);
    writeFileSync(join(tmpDir, 'OrderService.java'), ORDER_SERVICE);
    const result = indexProject(db, tmpDir, 'proj');

    const files = listProjectFiles(db, result.project.id);
    const cartFile = files.find(f => f.relative_path === 'CartService.java')!;
    const cartSymbols = getSymbolsByFile(db, cartFile.id);
    const processMethod = cartSymbols.find(s => s.name === 'process')!;

    const refs = getRefsByTargetSymbol(db, processMethod.id);
    // After cross-file resolution, process() should have an incoming ref from OrderService
    expect(refs.length).toBeGreaterThan(0);
  });

  it('removes process() from dead code once it is referenced cross-file', () => {
    writeFileSync(join(tmpDir, 'CartService.java'), CART_SERVICE);
    writeFileSync(join(tmpDir, 'OrderService.java'), ORDER_SERVICE);
    const result = indexProject(db, tmpDir, 'proj');
    const dead = findDeadCode(db, result.project.id, 'method');
    // process() is called from OrderService → not dead
    expect(dead.some(s => s.name === 'process')).toBe(false);
  });
});
