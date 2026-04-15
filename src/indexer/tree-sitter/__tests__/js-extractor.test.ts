import { describe, it, expect } from 'vitest';
import { parseFile } from '../parser.js';
import { extractFromJS } from '../js-extractor.js';
import type Parser from 'tree-sitter';

function parseTS(source: string): Parser.Tree {
  const tree = parseFile('Test.ts', source);
  if (!tree) throw new Error('Failed to parse TypeScript source');
  return tree;
}

function parseJS(source: string): Parser.Tree {
  const tree = parseFile('test.js', source);
  if (!tree) throw new Error('Failed to parse JavaScript source');
  return tree;
}

function parseTSX(source: string): Parser.Tree {
  const tree = parseFile('App.tsx', source);
  if (!tree) throw new Error('Failed to parse TSX source');
  return tree;
}

// ─── JS Symbol Kinds ──────────────────────────────────────────────────────────

describe('extractFromJS — JS symbol kinds', () => {
  it('extracts a top-level function declaration', () => {
    const { symbols } = extractFromJS(parseJS('function greet(name) {}'), 'javascript');
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe('greet');
    expect(symbols[0].kind).toBe('function');
    expect(symbols[0].start_line).toBe(1);
    expect(symbols[0].parent_id).toBeNull();
  });

  it('extracts a generator function declaration', () => {
    const { symbols } = extractFromJS(parseJS('function* gen() {}'), 'javascript');
    expect(symbols[0].kind).toBe('function');
    expect(symbols[0].modifiers).toContain('generator');
  });

  it('extracts a const arrow function', () => {
    const { symbols } = extractFromJS(parseJS('const add = (a, b) => a + b;'), 'javascript');
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe('add');
    expect(symbols[0].kind).toBe('function');
    expect(symbols[0].modifiers).toContain('const');
    expect(symbols[0].modifiers).toContain('arrow');
  });

  it('extracts a const function expression', () => {
    const { symbols } = extractFromJS(parseJS('const fn = function() {};'), 'javascript');
    expect(symbols[0].kind).toBe('function');
    expect(symbols[0].modifiers).toContain('const');
    expect(symbols[0].modifiers).not.toContain('arrow');
  });

  it('extracts a class with method and field', () => {
    const src = `
class Animal {
  name = 'cat';
  speak() { return this.name; }
}`.trim();
    const { symbols } = extractFromJS(parseJS(src), 'javascript');
    const cls = symbols.find(s => s.kind === 'class');
    const method = symbols.find(s => s.kind === 'method');
    const field = symbols.find(s => s.kind === 'field');
    expect(cls?.name).toBe('Animal');
    expect(method?.name).toBe('speak');
    expect(field?.name).toBe('name');
    expect(method?.parent_id).toBe((cls as { _nodeId?: number })._nodeId);
  });

  it('extracts constructor', () => {
    const { symbols } = extractFromJS(parseJS('class Foo { constructor(x) {} }'), 'javascript');
    const ctor = symbols.find(s => s.kind === 'constructor');
    expect(ctor?.name).toBe('constructor');
  });

  it('extracts getter and setter', () => {
    const src = `class Box { get value() {} set value(v) {} }`;
    const { symbols } = extractFromJS(parseJS(src), 'javascript');
    expect(symbols.some(s => s.kind === 'getter' && s.name === 'value')).toBe(true);
    expect(symbols.some(s => s.kind === 'setter' && s.name === 'value')).toBe(true);
  });

  it('extracts a variable (non-function const)', () => {
    const { symbols } = extractFromJS(parseJS('const PI = 3.14;'), 'javascript');
    expect(symbols[0].name).toBe('PI');
    expect(symbols[0].kind).toBe('variable');
    expect(symbols[0].modifiers).toContain('const');
  });

  it('extracts multiple declarators in one const', () => {
    const { symbols } = extractFromJS(parseJS('const a = 1, b = 2;'), 'javascript');
    expect(symbols).toHaveLength(2);
    expect(symbols.map(s => s.name)).toContain('a');
    expect(symbols.map(s => s.name)).toContain('b');
  });

  it('extracts an exported function', () => {
    const { symbols } = extractFromJS(parseJS('export function hello() {}'), 'javascript');
    expect(symbols[0].name).toBe('hello');
    expect(symbols[0].kind).toBe('function');
  });

  it('extracts an exported const arrow', () => {
    const { symbols } = extractFromJS(parseJS('export const fn = () => {};'), 'javascript');
    expect(symbols[0].name).toBe('fn');
    expect(symbols[0].kind).toBe('function');
  });

  it('extracts export default anonymous function', () => {
    const { symbols } = extractFromJS(parseJS('export default function() {}'), 'javascript');
    expect(symbols[0].name).toBe('default');
    expect(symbols[0].kind).toBe('function');
    expect(symbols[0].modifiers).toContain('export');
  });

  it('extracts export default anonymous class', () => {
    const { symbols } = extractFromJS(parseJS('export default class {}'), 'javascript');
    expect(symbols[0].name).toBe('default');
    expect(symbols[0].kind).toBe('class');
  });

  it('extracts a static class method', () => {
    const { symbols } = extractFromJS(parseJS('class Util { static create() {} }'), 'javascript');
    const method = symbols.find(s => s.kind === 'method');
    expect(method?.modifiers).toContain('static');
  });
});

// ─── TS Symbol Kinds ──────────────────────────────────────────────────────────

describe('extractFromJS — TS symbol kinds', () => {
  it('extracts an interface', () => {
    const { symbols } = extractFromJS(parseTS('interface User { id: number; name: string; }'), 'typescript');
    const iface = symbols.find(s => s.kind === 'interface');
    expect(iface?.name).toBe('User');
    const fields = symbols.filter(s => s.kind === 'field');
    expect(fields.map(f => f.name)).toContain('id');
    expect(fields.map(f => f.name)).toContain('name');
  });

  it('extracts a type alias', () => {
    const { symbols } = extractFromJS(parseTS('type ID = string | number;'), 'typescript');
    expect(symbols[0].name).toBe('ID');
    expect(symbols[0].kind).toBe('type_alias');
  });

  it('extracts an enum with members', () => {
    const { symbols } = extractFromJS(parseTS('enum Color { Red, Green, Blue }'), 'typescript');
    const en = symbols.find(s => s.kind === 'enum');
    expect(en?.name).toBe('Color');
    const members = symbols.filter(s => s.kind === 'field');
    expect(members.map(m => m.name)).toContain('Red');
    expect(members.map(m => m.name)).toContain('Green');
    expect(members.map(m => m.name)).toContain('Blue');
  });

  it('extracts a const enum', () => {
    const { symbols } = extractFromJS(parseTS('const enum Dir { Up = 0, Down = 1 }'), 'typescript');
    expect(symbols.find(s => s.kind === 'enum')?.name).toBe('Dir');
    expect(symbols.filter(s => s.kind === 'field')).toHaveLength(2);
  });

  it('extracts a namespace with a function inside', () => {
    const src = `namespace Api { export function fetch(): void {} }`;
    const { symbols } = extractFromJS(parseTS(src), 'typescript');
    const ns = symbols.find(s => s.kind === 'namespace');
    const fn = symbols.find(s => s.kind === 'function');
    expect(ns?.name).toBe('Api');
    expect(fn?.name).toBe('fetch');
    expect(fn?.parent_id).toBe((ns as { _nodeId?: number })._nodeId);
  });

  it('extracts an abstract class', () => {
    const { symbols } = extractFromJS(parseTS('abstract class Shape { abstract draw(): void; }'), 'typescript');
    const cls = symbols.find(s => s.kind === 'class');
    expect(cls?.name).toBe('Shape');
    expect(cls?.modifiers).toContain('abstract');
  });

  it('extracts a TS class with typed fields and method', () => {
    const src = `
class Point {
  x: number;
  y: number;
  distance(): number { return 0; }
}`.trim();
    const { symbols } = extractFromJS(parseTS(src), 'typescript');
    expect(symbols.find(s => s.name === 'x')?.kind).toBe('field');
    expect(symbols.find(s => s.name === 'distance')?.kind).toBe('method');
  });

  it('extracts a TS function with return type in signature', () => {
    const { symbols } = extractFromJS(parseTS('function add(a: number, b: number): number {}'), 'typescript');
    expect(symbols[0].signature).toContain('add');
    expect(symbols[0].signature).toContain('number');
  });

  it('extracts an exported interface', () => {
    const { symbols } = extractFromJS(parseTS('export interface Config { debug: boolean; }'), 'typescript');
    expect(symbols.find(s => s.kind === 'interface')?.name).toBe('Config');
  });
});

// ─── Symbol Hierarchy ─────────────────────────────────────────────────────────

describe('extractFromJS — symbol hierarchy', () => {
  it('class methods get the class as parent', () => {
    const src = `
class Calc {
  add(a, b) { return a + b; }
  sub(a, b) { return a - b; }
}`.trim();
    const { symbols } = extractFromJS(parseJS(src), 'javascript');
    const cls = symbols.find(s => s.kind === 'class')!;
    const methods = symbols.filter(s => s.kind === 'method');
    expect(methods).toHaveLength(2);
    methods.forEach(m => {
      expect(m.parent_id).toBe((cls as { _nodeId?: number })._nodeId);
    });
  });

  it('top-level symbols have null parent_id', () => {
    const { symbols } = extractFromJS(parseJS('function foo() {}\nfunction bar() {}'), 'javascript');
    symbols.forEach(s => expect(s.parent_id).toBeNull());
  });

  it('nested class inside namespace', () => {
    const src = `namespace Ns { export class Inner {} }`;
    const { symbols } = extractFromJS(parseTS(src), 'typescript');
    const ns = symbols.find(s => s.kind === 'namespace')!;
    const cls = symbols.find(s => s.kind === 'class')!;
    expect(cls.parent_id).toBe((ns as { _nodeId?: number })._nodeId);
  });
});

// ─── Dependencies ─────────────────────────────────────────────────────────────

describe('extractFromJS — dependencies', () => {
  it('extracts ESM named import', () => {
    const { dependencies } = extractFromJS(parseTS("import { useState } from 'react';"), 'typescript');
    expect(dependencies).toHaveLength(1);
    expect(dependencies[0].targetFqn).toBe('react');
    expect(dependencies[0].kind).toBe('import');
  });

  it('extracts ESM default import', () => {
    const { dependencies } = extractFromJS(parseJS("import React from 'react';"), 'javascript');
    expect(dependencies[0].targetFqn).toBe('react');
    expect(dependencies[0].kind).toBe('import');
  });

  it('extracts ESM namespace import', () => {
    const { dependencies } = extractFromJS(parseJS("import * as fs from 'fs';"), 'javascript');
    expect(dependencies[0].targetFqn).toBe('fs');
  });

  it('extracts re-export source', () => {
    const { dependencies } = extractFromJS(parseJS("export { foo } from './foo';"), 'javascript');
    expect(dependencies.some(d => d.targetFqn === './foo')).toBe(true);
  });

  it('extracts class extends', () => {
    const { dependencies } = extractFromJS(parseJS('class Dog extends Animal {}'), 'javascript');
    expect(dependencies.some(d => d.targetFqn === 'Animal' && d.kind === 'extends')).toBe(true);
  });

  it('extracts TS implements', () => {
    const { dependencies } = extractFromJS(parseTS('class Cat implements Serializable {}'), 'typescript');
    expect(dependencies.some(d => d.targetFqn === 'Serializable' && d.kind === 'implements')).toBe(true);
  });

  it('extracts TS interface extends', () => {
    const { dependencies } = extractFromJS(parseTS('interface A extends B, C {}'), 'typescript');
    expect(dependencies.some(d => d.targetFqn === 'B' && d.kind === 'extends')).toBe(true);
    expect(dependencies.some(d => d.targetFqn === 'C' && d.kind === 'extends')).toBe(true);
  });

  it('extracts CommonJS require()', () => {
    const { dependencies } = extractFromJS(parseJS("const path = require('path');"), 'javascript');
    expect(dependencies.some(d => d.targetFqn === 'path' && d.kind === 'import')).toBe(true);
  });

  it('extracts multiple imports from one file', () => {
    const src = `
import { a } from './a';
import { b } from './b';
import { c } from './c';
`.trim();
    const { dependencies } = extractFromJS(parseTS(src), 'typescript');
    expect(dependencies.map(d => d.targetFqn)).toContain('./a');
    expect(dependencies.map(d => d.targetFqn)).toContain('./b');
    expect(dependencies.map(d => d.targetFqn)).toContain('./c');
  });
});

// ─── Refs ─────────────────────────────────────────────────────────────────────

describe('extractFromJS — refs', () => {
  it('extracts a simple function call ref', () => {
    const src = `function a() { b(); }`;
    const { refs } = extractFromJS(parseJS(src), 'javascript');
    expect(refs.some(r => r.callerName === 'a' && r.calleeName === 'b' && r.kind === 'call')).toBe(true);
  });

  it('extracts obj.method() — last identifier rule', () => {
    const src = `function handler() { service.save(); }`;
    const { refs } = extractFromJS(parseJS(src), 'javascript');
    expect(refs.some(r => r.calleeName === 'save' && r.kind === 'call')).toBe(true);
  });

  it('extracts new Foo() as call ref', () => {
    const src = `function build() { new Widget(); }`;
    const { refs } = extractFromJS(parseJS(src), 'javascript');
    expect(refs.some(r => r.calleeName === 'Widget' && r.kind === 'call')).toBe(true);
  });

  it('extracts TS type reference', () => {
    const src = `function process(input: MyModel): Response {}`;
    const { refs } = extractFromJS(parseTS(src), 'typescript');
    expect(refs.some(r => r.calleeName === 'MyModel' && r.kind === 'type_reference')).toBe(true);
    expect(refs.some(r => r.calleeName === 'Response' && r.kind === 'type_reference')).toBe(true);
  });

  it('does not emit primitive types as type_reference', () => {
    const src = `function foo(x: string): number { return 0; }`;
    const { refs } = extractFromJS(parseTS(src), 'typescript');
    expect(refs.every(r => r.calleeName !== 'string')).toBe(true);
    expect(refs.every(r => r.calleeName !== 'number')).toBe(true);
  });

  it('extracts a method call ref', () => {
    const src = `class A { go() { this.helper(); } helper() {} }`;
    const { refs } = extractFromJS(parseJS(src), 'javascript');
    expect(refs.some(r => r.calleeName === 'helper' && r.kind === 'call')).toBe(true);
  });
});

// ─── JSX/TSX refs ─────────────────────────────────────────────────────────────

describe('extractFromJS — JSX/TSX component refs', () => {
  it('extracts a capitalized JSX component as call ref', () => {
    const src = `const Page = () => <MyButton />;`;
    const { refs } = extractFromJS(parseTSX(src), 'tsx');
    expect(refs.some(r => r.calleeName === 'MyButton' && r.kind === 'call')).toBe(true);
  });

  it('extracts JSX opening element ref', () => {
    const src = `const App = () => <Header>hello</Header>;`;
    const { refs } = extractFromJS(parseTSX(src), 'tsx');
    expect(refs.some(r => r.calleeName === 'Header' && r.kind === 'call')).toBe(true);
  });

  it('does not emit lowercase HTML elements as refs', () => {
    const src = `const App = () => <div><span /></div>;`;
    const { refs } = extractFromJS(parseTSX(src), 'tsx');
    expect(refs.every(r => r.calleeName !== 'div')).toBe(true);
    expect(refs.every(r => r.calleeName !== 'span')).toBe(true);
  });
});

// ─── CommonJS exports ─────────────────────────────────────────────────────────

describe('extractFromJS — CommonJS exports', () => {
  it('extracts module.exports = function as symbol', () => {
    const { symbols } = extractFromJS(parseJS('module.exports = function handler(req, res) {};'), 'javascript');
    expect(symbols.some(s => s.name === 'default' && s.kind === 'function')).toBe(true);
  });

  it('extracts exports.X = function', () => {
    const { symbols } = extractFromJS(parseJS('exports.greet = function() {};'), 'javascript');
    expect(symbols.some(s => s.name === 'greet' && s.kind === 'function')).toBe(true);
  });

  it('extracts module.exports = class', () => {
    const { symbols } = extractFromJS(parseJS('module.exports = class Service {};'), 'javascript');
    expect(symbols.some(s => s.name === 'default' && s.kind === 'class')).toBe(true);
  });

  it('does not create a symbol for module.exports = identifier (re-export)', () => {
    const { symbols } = extractFromJS(parseJS('module.exports = existingFn;'), 'javascript');
    // identifier RHS → no new symbol
    expect(symbols.every(s => s.name !== 'default')).toBe(true);
  });
});

// ─── Edge cases ───────────────────────────────────────────────────────────────

describe('extractFromJS — edge cases', () => {
  it('handles CRLF line endings', () => {
    const src = 'function greet() {}\r\nconst PI = 3.14;\r\n';
    const tree = parseTS(src.replace(/\r\n/g, '\r\n'));
    const { symbols } = extractFromJS(tree, 'typescript');
    expect(symbols.some(s => s.name === 'greet')).toBe(true);
  });

  it('handles BOM prefix', () => {
    const tree = parseTS('\uFEFFfunction bom() {}');
    const { symbols } = extractFromJS(tree, 'typescript');
    expect(symbols.some(s => s.name === 'bom')).toBe(true);
  });

  it('handles empty file', () => {
    const tree = parseJS('');
    const { symbols, dependencies, refs } = extractFromJS(tree, 'javascript');
    expect(symbols).toHaveLength(0);
    expect(dependencies).toHaveLength(0);
    expect(refs).toHaveLength(0);
  });

  it('handles 32K+ JS file via streaming callback', () => {
    const padding = '// comment\n'.repeat(3100); // ~3100 * 11 = 34,100 chars
    const src = `${padding}export function large() {}\n`;
    expect(src.length).toBeGreaterThan(32767);
    const tree = parseFile('Large.js', src);
    expect(tree).not.toBeNull();
    const { symbols } = extractFromJS(tree!, 'javascript');
    expect(symbols.some(s => s.name === 'large')).toBe(true);
  });

  it('handles class with both ESM extends and TS implements', () => {
    const src = `class Dog extends Animal implements Serializable {}`;
    const { dependencies } = extractFromJS(parseTS(src), 'typescript');
    expect(dependencies.some(d => d.kind === 'extends' && d.targetFqn === 'Animal')).toBe(true);
    expect(dependencies.some(d => d.kind === 'implements' && d.targetFqn === 'Serializable')).toBe(true);
  });
});
