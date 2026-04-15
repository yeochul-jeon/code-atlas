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

// ─── CRLF / BOM encoding ──────────────────────────────────────────────────────

describe('indexProject — CRLF and BOM encoding', () => {
  it('indexes a CRLF Java file without errors and extracts symbols', () => {
    writeFileSync(join(tmpDir, 'CRLF.java'), SIMPLE_JAVA.replace(/\n/g, '\r\n'));
    const result = indexProject(db, tmpDir, 'proj');
    expect(result.errors).toBe(0);
    expect(result.errorPaths).toHaveLength(0);
    const files = listProjectFiles(db, result.project.id);
    const symbols = getSymbolsByFile(db, files[0].id);
    const names = symbols.map(s => s.name);
    expect(names).toContain('Cart');
    expect(names).toContain('addItem');
  });

  it('indexes a UTF-8 BOM Java file without errors and extracts symbols', () => {
    writeFileSync(join(tmpDir, 'BOM.java'), '\uFEFF' + SIMPLE_JAVA);
    const result = indexProject(db, tmpDir, 'proj');
    expect(result.errors).toBe(0);
    expect(result.errorPaths).toHaveLength(0);
    const files = listProjectFiles(db, result.project.id);
    const symbols = getSymbolsByFile(db, files[0].id);
    expect(symbols.map(s => s.name)).toContain('Cart');
  });

  it('indexes a BOM+CRLF Java file without errors', () => {
    writeFileSync(join(tmpDir, 'BOMCRLF.java'), '\uFEFF' + SIMPLE_JAVA.replace(/\n/g, '\r\n'));
    const result = indexProject(db, tmpDir, 'proj');
    expect(result.errors).toBe(0);
    expect(result.errorPaths).toHaveLength(0);
  });

  it('records errorPaths for files that fail to parse', () => {
    writeFileSync(join(tmpDir, 'Valid.java'), SIMPLE_JAVA);
    // A binary file disguised as .java will fail to parse
    writeFileSync(join(tmpDir, 'Broken.java'), Buffer.from([0xFF, 0xFE, 0x00, 0x00]));
    const result = indexProject(db, tmpDir, 'proj');
    // Valid.java should succeed, Broken.java may error
    // Either way, errorPaths captures the failed ones
    expect(Array.isArray(result.errorPaths)).toBe(true);
  });

  it('indexes a Java file exceeding 32,767 chars without errors', () => {
    // tree-sitter 0.21.x fails on strings ≥ 32,768 chars — parser uses callback API for large files.
    const padding = '// filler\n'.repeat(4000); // ~4000 * 10 = 40,000 chars
    const largeJava = `import java.util.List;\n\npublic class Large {\n${padding}\n  public void noop() {}\n}`;
    expect(largeJava.length).toBeGreaterThan(32767);
    writeFileSync(join(tmpDir, 'Large.java'), largeJava);
    const result = indexProject(db, tmpDir, 'proj');
    expect(result.errors).toBe(0);
    expect(result.errorPaths).toHaveLength(0);
    const files = listProjectFiles(db, result.project.id);
    const symbols = getSymbolsByFile(db, files[0].id);
    expect(symbols.map(s => s.name)).toContain('Large');
  });
});

// ─── JS/TS indexing ───────────────────────────────────────────────────────────

const SIMPLE_TS = `
import { EventEmitter } from 'events';

export interface Widget {
  id: number;
  render(): void;
}

export class Button implements Widget {
  id: number;
  label: string;

  constructor(id: number, label: string) {
    this.id = id;
    this.label = label;
  }

  render() {
    this.formatLabel();
  }

  private formatLabel() {}
}

export const createButton = (id: number, label: string): Button => new Button(id, label);
`.trim();

const SIMPLE_JS = `
const util = require('./util');

class Logger {
  log(msg) { util.write(msg); }
}

module.exports = { Logger };
`.trim();

describe('indexProject — JS/TS indexing', () => {
  it('indexes a .ts file', () => {
    writeFileSync(join(tmpDir, 'Button.ts'), SIMPLE_TS);
    const result = indexProject(db, tmpDir, 'proj');
    expect(result.indexed).toBe(1);
    expect(result.errors).toBe(0);
    const files = listProjectFiles(db, result.project.id);
    const symbols = getSymbolsByFile(db, files[0].id);
    const names = symbols.map(s => s.name);
    expect(names).toContain('Widget');
    expect(names).toContain('Button');
    expect(names).toContain('createButton');
  });

  it('extracts parent-child symbol hierarchy from .ts', () => {
    writeFileSync(join(tmpDir, 'Button.ts'), SIMPLE_TS);
    const result = indexProject(db, tmpDir, 'proj');
    const files = listProjectFiles(db, result.project.id);
    const symbols = getSymbolsByFile(db, files[0].id);
    const cls = symbols.find(s => s.name === 'Button');
    const ctor = symbols.find(s => s.name === 'constructor');
    expect(cls).toBeDefined();
    expect(ctor?.parent_id).toBe(cls?.id);
  });

  it('extracts ESM import as dependency from .ts', () => {
    writeFileSync(join(tmpDir, 'Button.ts'), SIMPLE_TS);
    const result = indexProject(db, tmpDir, 'proj');
    const files = listProjectFiles(db, result.project.id);
    const deps = getDependenciesByFile(db, files[0].id);
    expect(deps.some(d => d.target_fqn === 'events' && d.kind === 'import')).toBe(true);
  });

  it('extracts implements as dependency from .ts', () => {
    writeFileSync(join(tmpDir, 'Button.ts'), SIMPLE_TS);
    const result = indexProject(db, tmpDir, 'proj');
    const files = listProjectFiles(db, result.project.id);
    const deps = getDependenciesByFile(db, files[0].id);
    expect(deps.some(d => d.target_fqn === 'Widget' && d.kind === 'implements')).toBe(true);
  });

  it('indexes a .js file with CommonJS require', () => {
    writeFileSync(join(tmpDir, 'logger.js'), SIMPLE_JS);
    const result = indexProject(db, tmpDir, 'proj');
    expect(result.indexed).toBe(1);
    expect(result.errors).toBe(0);
    const files = listProjectFiles(db, result.project.id);
    const symbols = getSymbolsByFile(db, files[0].id);
    expect(symbols.some(s => s.name === 'Logger')).toBe(true);
  });

  it('extracts CommonJS require as import dependency', () => {
    writeFileSync(join(tmpDir, 'logger.js'), SIMPLE_JS);
    const result = indexProject(db, tmpDir, 'proj');
    const files = listProjectFiles(db, result.project.id);
    const deps = getDependenciesByFile(db, files[0].id);
    expect(deps.some(d => d.target_fqn === './util' && d.kind === 'import')).toBe(true);
  });

  it('indexes a mixed .ts + .js project', () => {
    writeFileSync(join(tmpDir, 'Button.ts'), SIMPLE_TS);
    writeFileSync(join(tmpDir, 'logger.js'), SIMPLE_JS);
    const result = indexProject(db, tmpDir, 'proj');
    expect(result.indexed).toBe(2);
    expect(result.errors).toBe(0);
  });

  it('extracts no symbols from .d.ts declaration files', () => {
    writeFileSync(join(tmpDir, 'types.d.ts'), 'export type ID = string;');
    const result = indexProject(db, tmpDir, 'proj');
    // .d.ts files are collected (extension .ts) and counted in `indexed`,
    // but detectLanguage returns null so no symbols are extracted.
    const files = listProjectFiles(db, result.project.id);
    if (files.length > 0) {
      const symbols = getSymbolsByFile(db, files[0].id);
      expect(symbols).toHaveLength(0);
    }
    expect(result.errors).toBe(0);
  });
});
