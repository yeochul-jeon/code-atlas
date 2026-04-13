/**
 * Write Tools TDD Tests
 *
 * Tests for: verifySymbolPosition, atomicWriteFile,
 *            replaceSymbolBody, insertAfterSymbol, insertBeforeSymbol, renameSymbol
 *
 * Each describe group follows Red-Green-Refactor:
 * - Test is written first (RED)
 * - Minimal production code written to pass (GREEN)
 * - Refactor as needed
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { openDatabase } from '../../storage/database.js';
import { indexProject } from '../../indexer/indexer.js';
import { getSymbolsByFile, listProjectFiles } from '../../storage/queries.js';
import {
  verifySymbolPosition,
  atomicWriteFile,
  replaceSymbolBody,
  insertAfterSymbol,
  insertBeforeSymbol,
  renameSymbol,
} from '../write-tools.js';
import type { Db } from '../../storage/database.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const FOO_CLASS = `package com.example;

public class Foo {
    private int count = 0;

    public void greet() {
        System.out.println("hello");
    }

    public void other() {
        System.out.println("other");
    }
}
`;

const BAR_CLASS = `package com.example;

import com.example.Foo;

public class Bar {
    private Foo foo;

    public void useFoo() {
        foo.greet();
    }
}
`;

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeProject(files: Record<string, string>): { tmpDir: string; db: Db; projectId: number } {
  const tmpDir = mkdtempSync(join(tmpdir(), 'codeatlas-write-test-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(tmpDir, name), content, 'utf8');
  }
  const db = openDatabase(':memory:');
  const result = indexProject(db, tmpDir, 'test');
  return { tmpDir, db, projectId: result.project.id };
}

// ─── B1: verifySymbolPosition ─────────────────────────────────────────────────

describe('B1: verifySymbolPosition', () => {
  let tmpDir: string;
  let db: Db;
  let projectId: number;

  beforeEach(() => {
    ({ tmpDir, db, projectId } = makeProject({ 'Foo.java': FOO_CLASS }));
  });
  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns valid=true when symbol position matches DB', () => {
    const filePath = join(tmpDir, 'Foo.java');
    const files = listProjectFiles(db, projectId);
    const fileRecord = files[0];
    const symbols = getSymbolsByFile(db, fileRecord.id);
    const greet = symbols.find(s => s.name === 'greet')!;
    expect(greet).toBeDefined();

    const result = verifySymbolPosition(filePath, 'greet', greet.start_line, greet.end_line);
    expect(result.valid).toBe(true);
    expect(result.symbol).toBeDefined();
  });

  it('returns valid=false when file has been modified and symbol moved', () => {
    const filePath = join(tmpDir, 'Foo.java');
    const files = listProjectFiles(db, projectId);
    const fileRecord = files[0];
    const symbols = getSymbolsByFile(db, fileRecord.id);
    const greet = symbols.find(s => s.name === 'greet')!;
    const originalStart = greet.start_line;

    // Insert 5 lines before the method → shifts its position
    const original = readFileSync(filePath, 'utf8');
    writeFileSync(filePath, '\n\n\n\n\n' + original, 'utf8');

    const result = verifySymbolPosition(filePath, 'greet', originalStart, greet.end_line);
    expect(result.valid).toBe(false);
  });

  it('returns valid=false with reason not_found when symbol does not exist', () => {
    const filePath = join(tmpDir, 'Foo.java');
    const result = verifySymbolPosition(filePath, 'nonExistentMethod', 1, 5);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('not_found');
  });
});

// ─── B2: atomicWriteFile ──────────────────────────────────────────────────────

describe('B2: atomicWriteFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'codeatlas-atomic-test-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes content to file', () => {
    const filePath = join(tmpDir, 'test.txt');
    atomicWriteFile(filePath, 'hello world');
    expect(readFileSync(filePath, 'utf8')).toBe('hello world');
  });

  it('does not leave .tmp file after successful write', () => {
    const filePath = join(tmpDir, 'test.txt');
    atomicWriteFile(filePath, 'content');
    expect(existsSync(filePath + '.tmp')).toBe(false);
  });

  it('overwrites existing file content', () => {
    const filePath = join(tmpDir, 'test.txt');
    writeFileSync(filePath, 'original', 'utf8');
    atomicWriteFile(filePath, 'updated');
    expect(readFileSync(filePath, 'utf8')).toBe('updated');
  });
});

// ─── B3: replaceSymbolBody ────────────────────────────────────────────────────

describe('B3: replaceSymbolBody', () => {
  let tmpDir: string;
  let db: Db;
  let projectId: number;

  beforeEach(() => {
    ({ tmpDir, db, projectId } = makeProject({ 'Foo.java': FOO_CLASS }));
  });
  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('replaces method body with new content', () => {
    const filePath = join(tmpDir, 'Foo.java');
    const newBody = `    public void greet() {
        System.out.println("goodbye");
    }`;

    const result = replaceSymbolBody(db, filePath, 'greet', newBody);
    expect(result.success).toBe(true);

    const content = readFileSync(filePath, 'utf8');
    expect(content).toContain('goodbye');
    expect(content).not.toContain('hello');
  });

  it('preserves surrounding code after replacement', () => {
    const filePath = join(tmpDir, 'Foo.java');
    const newBody = `    public void greet() {
        System.out.println("changed");
    }`;

    replaceSymbolBody(db, filePath, 'greet', newBody);

    const content = readFileSync(filePath, 'utf8');
    expect(content).toContain('other'); // other() method preserved
    expect(content).toContain('private int count'); // field preserved
  });

  it('re-indexes file after replacement so DB reflects new content', () => {
    const filePath = join(tmpDir, 'Foo.java');
    const newBody = `    public void greet() {
        System.out.println("changed");
        doSomethingNew();
    }`;

    replaceSymbolBody(db, filePath, 'greet', newBody);

    // DB should still have greet (re-indexed)
    const files = listProjectFiles(db, projectId);
    const symbols = getSymbolsByFile(db, files[0].id);
    expect(symbols.some(s => s.name === 'greet')).toBe(true);
  });

  it('returns error when symbol does not exist in file', () => {
    const filePath = join(tmpDir, 'Foo.java');
    const result = replaceSymbolBody(db, filePath, 'nonExistent', 'body');
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('returns error when file is not indexed', () => {
    const result = replaceSymbolBody(db, '/tmp/notIndexed.java', 'greet', 'body');
    expect(result.success).toBe(false);
  });
});

// ─── B4: insertAfterSymbol ────────────────────────────────────────────────────

describe('B4: insertAfterSymbol', () => {
  let tmpDir: string;
  let db: Db;
  let projectId: number;

  beforeEach(() => {
    ({ tmpDir, db, projectId } = makeProject({ 'Foo.java': FOO_CLASS }));
  });
  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('inserts content after the symbol end_line', () => {
    const filePath = join(tmpDir, 'Foo.java');
    const inserted = `\n    public void inserted() {\n        // new method\n    }`;

    const result = insertAfterSymbol(db, filePath, 'greet', inserted);
    expect(result.success).toBe(true);

    const content = readFileSync(filePath, 'utf8');
    // inserted() should appear after greet() and before other()
    const greetPos = content.indexOf('greet()');
    const insertedPos = content.indexOf('inserted()');
    const otherPos = content.indexOf('other()');
    expect(insertedPos).toBeGreaterThan(greetPos);
    expect(insertedPos).toBeLessThan(otherPos);
  });

  it('re-indexes file after insertion', () => {
    const filePath = join(tmpDir, 'Foo.java');
    replaceSymbolBody; // just ensure import works
    const result = insertAfterSymbol(db, filePath, 'greet', '\n    public void newMethod() {}');
    expect(result.success).toBe(true);

    const files = listProjectFiles(db, projectId);
    const symbols = getSymbolsByFile(db, files[0].id);
    expect(symbols.some(s => s.name === 'newMethod')).toBe(true);
  });

  it('returns error for non-existent symbol', () => {
    const filePath = join(tmpDir, 'Foo.java');
    const result = insertAfterSymbol(db, filePath, 'doesNotExist', 'content');
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });
});

// ─── B5: insertBeforeSymbol ───────────────────────────────────────────────────

describe('B5: insertBeforeSymbol', () => {
  let tmpDir: string;
  let db: Db;
  let projectId: number;

  beforeEach(() => {
    ({ tmpDir, db, projectId } = makeProject({ 'Foo.java': FOO_CLASS }));
  });
  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('inserts content before the symbol start_line', () => {
    const filePath = join(tmpDir, 'Foo.java');
    const inserted = `    public void before() {\n        // before greet\n    }\n`;

    const result = insertBeforeSymbol(db, filePath, 'greet', inserted);
    expect(result.success).toBe(true);

    const content = readFileSync(filePath, 'utf8');
    const beforePos = content.indexOf('before()');
    const greetPos = content.indexOf('greet()');
    expect(beforePos).toBeLessThan(greetPos);
  });

  it('re-indexes file after insertion', () => {
    const filePath = join(tmpDir, 'Foo.java');
    insertBeforeSymbol(db, filePath, 'greet', '    public void injected() {}\n');

    const files = listProjectFiles(db, projectId);
    const symbols = getSymbolsByFile(db, files[0].id);
    expect(symbols.some(s => s.name === 'injected')).toBe(true);
  });

  it('returns error for non-existent symbol', () => {
    const filePath = join(tmpDir, 'Foo.java');
    const result = insertBeforeSymbol(db, filePath, 'missing', 'content');
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });
});

// ─── B6: renameSymbol ────────────────────────────────────────────────────────

describe('B6: renameSymbol', () => {
  let tmpDir: string;
  let db: Db;
  let projectId: number;

  beforeEach(() => {
    ({ tmpDir, db, projectId } = makeProject({
      'Foo.java': FOO_CLASS,
      'Bar.java': BAR_CLASS,
    }));
  });
  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('renames method in its declaring file', () => {
    const filePath = join(tmpDir, 'Foo.java');
    const result = renameSymbol(db, filePath, 'greet', 'sayHello');
    expect(result.success).toBe(true);

    const content = readFileSync(filePath, 'utf8');
    expect(content).toContain('sayHello');
    expect(content).not.toMatch(/\bgreet\b/);
  });

  it('renames references in other files in the same project', () => {
    const fooPath = join(tmpDir, 'Foo.java');
    const result = renameSymbol(db, fooPath, 'greet', 'sayHello');
    expect(result.success).toBe(true);

    const barContent = readFileSync(join(tmpDir, 'Bar.java'), 'utf8');
    expect(barContent).toContain('sayHello');
    expect(barContent).not.toMatch(/\bgreet\b/);
  });

  it('returns list of changed files', () => {
    const fooPath = join(tmpDir, 'Foo.java');
    const result = renameSymbol(db, fooPath, 'greet', 'sayHello');
    expect(result.success).toBe(true);
    expect(result.changedFiles).toBeDefined();
    expect(result.changedFiles!.length).toBeGreaterThanOrEqual(1);
  });

  it('re-indexes all changed files', () => {
    const fooPath = join(tmpDir, 'Foo.java');
    renameSymbol(db, fooPath, 'greet', 'sayHello');

    const files = listProjectFiles(db, projectId);
    const allSymbols = files.flatMap(f => getSymbolsByFile(db, f.id));
    expect(allSymbols.some(s => s.name === 'sayHello')).toBe(true);
    expect(allSymbols.some(s => s.name === 'greet')).toBe(false);
  });

  it('does not rename partial word matches (word-boundary)', () => {
    // "greet" should not match inside "greeter" or "greeted"
    const tmpDir2 = mkdtempSync(join(tmpdir(), 'codeatlas-rename-test2-'));
    const content = `public class Test {\n    public void greet() {}\n    public void greeter() {}\n}\n`;
    writeFileSync(join(tmpDir2, 'Test.java'), content, 'utf8');
    const db2 = openDatabase(':memory:');
    const r = indexProject(db2, tmpDir2, 'test2');

    renameSymbol(db2, join(tmpDir2, 'Test.java'), 'greet', 'hello');
    const newContent = readFileSync(join(tmpDir2, 'Test.java'), 'utf8');

    db2.close();
    rmSync(tmpDir2, { recursive: true, force: true });

    expect(newContent).toContain('hello()');
    expect(newContent).toContain('greeter()'); // NOT renamed
    expect(newContent).not.toMatch(/\bgreet\b/); // original name gone
  });

  it('returns error for symbol not found in file', () => {
    const fooPath = join(tmpDir, 'Foo.java');
    const result = renameSymbol(db, fooPath, 'nonExistent', 'newName');
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });
});
