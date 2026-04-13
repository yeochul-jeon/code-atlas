import { describe, it, expect } from 'vitest';
import { parseFile } from '../parser.js';
import { extractFromJava } from '../java-extractor.js';
import type Parser from 'tree-sitter';

function parse(source: string): Parser.Tree {
  const tree = parseFile('Test.java', source);
  if (!tree) throw new Error('Failed to parse Java source');
  return tree;
}

// ─── Class / Interface / Enum / Record ───────────────────────────────────────

describe('extractFromJava — classes', () => {
  it('extracts a simple class', () => {
    const tree = parse(`public class Foo {}`);
    const { symbols } = extractFromJava(tree);
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe('Foo');
    expect(symbols[0].kind).toBe('class');
    expect(symbols[0].start_line).toBe(1);
  });

  it('extracts class modifiers', () => {
    const tree = parse(`public final class Bar {}`);
    const { symbols } = extractFromJava(tree);
    expect(symbols[0].modifiers).toContain('public');
    expect(symbols[0].modifiers).toContain('final');
  });

  it('extracts annotations on a class', () => {
    const tree = parse(`
@Service
public class SomeService {}
`.trim());
    const { symbols } = extractFromJava(tree);
    expect(symbols[0].annotations).toContain('@Service');
  });

  it('extracts an interface', () => {
    const tree = parse(`public interface MyInterface {}`);
    const { symbols } = extractFromJava(tree);
    expect(symbols[0].kind).toBe('interface');
    expect(symbols[0].name).toBe('MyInterface');
  });

  it('extracts an enum', () => {
    const tree = parse(`public enum Color { RED, GREEN, BLUE }`);
    const { symbols } = extractFromJava(tree);
    expect(symbols[0].kind).toBe('enum');
    expect(symbols[0].name).toBe('Color');
  });

  it('extracts a record', () => {
    const tree = parse(`public record Point(int x, int y) {}`);
    const { symbols } = extractFromJava(tree);
    expect(symbols[0].kind).toBe('record');
    expect(symbols[0].name).toBe('Point');
  });

  it('extracts an annotation type', () => {
    const tree = parse(`public @interface MyAnnotation {}`);
    const { symbols } = extractFromJava(tree);
    expect(symbols[0].kind).toBe('annotation_type');
    expect(symbols[0].name).toBe('MyAnnotation');
  });
});

// ─── Methods & Fields ─────────────────────────────────────────────────────────

describe('extractFromJava — methods and fields', () => {
  const source = `
public class Cart {
  private int count;

  public Cart() {}

  public void addItem(String item) {}

  public int getCount() { return count; }
}
`.trim();

  it('extracts methods and constructor', () => {
    const tree = parse(source);
    const { symbols } = extractFromJava(tree);
    const kinds = symbols.map(s => s.kind);
    expect(kinds).toContain('class');
    expect(kinds).toContain('field');
    expect(kinds).toContain('constructor');
    expect(kinds.filter(k => k === 'method')).toHaveLength(2);
  });

  it('builds method signature with return type and params', () => {
    const tree = parse(source);
    const { symbols } = extractFromJava(tree);
    const addItem = symbols.find(s => s.name === 'addItem');
    expect(addItem?.signature).toContain('addItem');
    expect(addItem?.signature).toContain('(');
  });

  it('builds constructor signature', () => {
    const tree = parse(source);
    const { symbols } = extractFromJava(tree);
    const ctor = symbols.find(s => s.kind === 'constructor');
    expect(ctor?.signature).toContain('Cart');
  });

  it('builds field signature with type', () => {
    const tree = parse(source);
    const { symbols } = extractFromJava(tree);
    const field = symbols.find(s => s.kind === 'field');
    expect(field?.signature).toContain('int');
    expect(field?.signature).toContain('count');
  });
});

// ─── Parent-child relationships ───────────────────────────────────────────────

describe('extractFromJava — symbol hierarchy', () => {
  it('assigns parent_id to nested symbols', () => {
    const tree = parse(`
public class Outer {
  public void method() {}
}
`.trim());
    const { symbols } = extractFromJava(tree);
    const outer = symbols.find(s => s.kind === 'class');
    const method = symbols.find(s => s.kind === 'method');
    expect(outer).toBeDefined();
    expect(method).toBeDefined();
    // parent_id uses the local counter assigned during extraction
    expect(method!.parent_id).toBe((outer as { _nodeId?: number })._nodeId);
  });

  it('top-level class has null parent_id', () => {
    const tree = parse(`public class Standalone {}`);
    const { symbols } = extractFromJava(tree);
    expect(symbols[0].parent_id).toBeNull();
  });
});

// ─── Dependencies ─────────────────────────────────────────────────────────────

describe('extractFromJava — dependencies', () => {
  const source = `
import java.util.List;
import java.util.Map;

public class Foo extends BaseClass implements Runnable, Serializable {}
`.trim();

  it('extracts import dependencies', () => {
    const tree = parse(source);
    const { dependencies } = extractFromJava(tree);
    const imports = dependencies.filter(d => d.kind === 'import');
    expect(imports.map(d => d.targetFqn)).toContain('java.util.List');
    expect(imports.map(d => d.targetFqn)).toContain('java.util.Map');
  });

  it('extracts extends dependency', () => {
    const tree = parse(source);
    const { dependencies } = extractFromJava(tree);
    const ext = dependencies.find(d => d.kind === 'extends');
    expect(ext?.targetFqn).toBe('BaseClass');
  });

  it('extracts implements dependencies', () => {
    const tree = parse(source);
    const { dependencies } = extractFromJava(tree);
    const impls = dependencies.filter(d => d.kind === 'implements');
    const fqns = impls.map(d => d.targetFqn);
    expect(fqns).toContain('Runnable');
    expect(fqns).toContain('Serializable');
  });
});

// ─── Call References ──────────────────────────────────────────────────────────

describe('extractFromJava — refs', () => {
  it('extracts method call refs from method bodies', () => {
    const tree = parse(`
public class A {
  public void doWork() {
    helper();
    process();
  }
  private void helper() {}
  private void process() {}
}
`.trim());
    const { refs } = extractFromJava(tree);
    expect(refs.some(r => r.calleeName === 'helper')).toBe(true);
    expect(refs.some(r => r.calleeName === 'process')).toBe(true);
    expect(refs.every(r => r.kind === 'call')).toBe(true);
    expect(refs.every(r => r.callerName === 'doWork')).toBe(true);
  });

  it('extracts method name (not object) from object.method() call', () => {
    // cartService.process() → calleeName should be 'process', not 'cartService'
    const tree = parse(`
public class OrderService {
  private CartService cartService;
  public void submit() {
    cartService.process();
  }
}
`.trim());
    const { refs } = extractFromJava(tree);
    expect(refs.some(r => r.calleeName === 'process')).toBe(true);
    expect(refs.some(r => r.calleeName === 'cartService')).toBe(false);
  });

  it('returns no refs for empty methods', () => {
    const tree = parse(`public class B { public void empty() {} }`);
    const { refs } = extractFromJava(tree);
    expect(refs).toHaveLength(0);
  });
});

// ─── Complex cases ────────────────────────────────────────────────────────────

describe('extractFromJava — complex cases', () => {
  it('handles multiple top-level classes in one file', () => {
    // Tree-sitter allows this even if Java compiler doesn't always
    const tree = parse(`
class Alpha {}
class Beta {}
`.trim());
    const { symbols } = extractFromJava(tree);
    expect(symbols.map(s => s.name)).toContain('Alpha');
    expect(symbols.map(s => s.name)).toContain('Beta');
  });

  it('handles annotated methods', () => {
    const tree = parse(`
public class Svc {
  @Override
  public String toString() { return "x"; }
}
`.trim());
    const { symbols } = extractFromJava(tree);
    const method = symbols.find(s => s.kind === 'method');
    expect(method?.annotations).toContain('@Override');
  });
});
