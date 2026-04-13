import { describe, it, expect } from 'vitest';
import { detectLanguage, parseFile, getParser } from '../parser.js';

describe('detectLanguage', () => {
  it('detects .java as java', () => {
    expect(detectLanguage('Foo.java')).toBe('java');
    expect(detectLanguage('/path/to/Bar.java')).toBe('java');
  });

  it('returns null for .kt (Kotlin not yet enabled)', () => {
    expect(detectLanguage('Foo.kt')).toBeNull();
  });

  it('returns null for unknown extensions', () => {
    expect(detectLanguage('script.py')).toBeNull();
    expect(detectLanguage('app.ts')).toBeNull();
    expect(detectLanguage('Makefile')).toBeNull();
  });
});

describe('getParser', () => {
  it('returns a Parser instance for java', () => {
    const parser = getParser('java');
    expect(parser).toBeDefined();
    expect(typeof parser.parse).toBe('function');
  });

  it('returns the same parser instance (singleton)', () => {
    const p1 = getParser('java');
    const p2 = getParser('java');
    expect(p1).toBe(p2);
  });

  it('throws for unsupported language', () => {
    // @ts-expect-error intentional unsupported language
    expect(() => getParser('python')).toThrow('Language not supported');
  });
});

describe('parseFile', () => {
  const simpleJava = `
public class Hello {
  public void greet() {}
}
`.trim();

  it('parses a valid Java file and returns a Tree', () => {
    const tree = parseFile('Hello.java', simpleJava);
    expect(tree).not.toBeNull();
    expect(tree?.rootNode.type).toBe('program');
  });

  it('returns null for non-Java files', () => {
    expect(parseFile('Hello.kt', simpleJava)).toBeNull();
    expect(parseFile('hello.py', simpleJava)).toBeNull();
  });
});
