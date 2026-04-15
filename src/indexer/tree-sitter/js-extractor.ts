import type Parser from 'tree-sitter';
import type { InsertSymbolParams } from '../../storage/queries.js';
import type { SupportedLanguage } from './parser.js';
import type { ExtractionResult, ExtractedDependency, ExtractedRef } from './java-extractor.js';

// Local type that smuggles a transient node ID for parent_id resolution in the indexer.
// The _nodeId field is read back via (sym as { _nodeId?: number })._nodeId.
interface SymbolEntry extends Omit<InsertSymbolParams, 'file_id'> {
  _nodeId?: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const JS_TS_MODIFIERS = new Set([
  'static', 'async', 'abstract', 'override', 'readonly',
  'declare', 'public', 'private', 'protected', 'accessor',
]);

// Filter out common built-in / primitive type identifiers from type_reference refs.
const PRIMITIVE_TYPES = new Set([
  'string', 'number', 'boolean', 'void', 'null', 'undefined',
  'never', 'any', 'unknown', 'object', 'symbol', 'bigint',
  'String', 'Number', 'Boolean', 'Object', 'Function',
  'Promise', 'Array', 'Map', 'Set', 'Error', 'Date',
  'RegExp', 'Symbol', 'BigInt', 'Uint8Array', 'ArrayBuffer',
  'ReadonlyArray', 'Record', 'Partial', 'Required', 'Readonly',
  'Pick', 'Omit', 'Exclude', 'Extract', 'NonNullable',
  'ReturnType', 'InstanceType', 'Parameters', 'ConstructorParameters',
]);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function text(node: Parser.SyntaxNode): string {
  return node.text.trim();
}

function collectModifiers(node: Parser.SyntaxNode): string[] {
  return node.children
    .filter(c => JS_TS_MODIFIERS.has(c.type))
    .map(c => c.type);
}

function buildFunctionSignature(name: string, node: Parser.SyntaxNode): string {
  const params = node.childForFieldName('parameters');
  const returnType = node.childForFieldName('return_type');
  const paramStr = params ? text(params) : '()';
  // return_type node text starts with ': ' in tree-sitter-typescript
  const retStr = returnType ? text(returnType).replace(/^:?\s*/, ': ') : '';
  return `${name}${paramStr}${retStr}`;
}

function buildFieldSignature(name: string, node: Parser.SyntaxNode): string | null {
  const typeField = node.childForFieldName('type');
  if (typeField) return `${name}: ${text(typeField).replace(/^:\s*/, '')}`;
  const typeAnnotation = node.children.find(c => c.type === 'type_annotation');
  if (typeAnnotation) return `${name}: ${text(typeAnnotation).replace(/^:\s*/, '')}`;
  return null;
}

// ─── Classification ───────────────────────────────────────────────────────────

function classifyMethodDef(node: Parser.SyntaxNode): { kind: string; modifiers: string[] } {
  const modifiers = collectModifiers(node);

  // In tree-sitter-javascript 0.21.x the get/set/* tokens are unnamed children,
  // NOT accessible via childForFieldName('kind'). Check children directly.
  if (node.children.some(c => c.type === 'get')) return { kind: 'getter', modifiers };
  if (node.children.some(c => c.type === 'set')) return { kind: 'setter', modifiers };
  if (node.children.some(c => c.type === '*')) modifiers.push('generator');

  const nameNode = node.childForFieldName('name');
  if (nameNode?.text === 'constructor') return { kind: 'constructor', modifiers };

  return { kind: 'method', modifiers };
}

function classifyNode(node: Parser.SyntaxNode): { kind: string; modifiers?: string[] } | null {
  switch (node.type) {
    case 'function_declaration':
      return { kind: 'function' };
    case 'generator_function_declaration':
      return { kind: 'function', modifiers: ['generator'] };
    case 'class_declaration':
      return { kind: 'class' };
    case 'abstract_class_declaration':
      return { kind: 'class', modifiers: ['abstract'] };
    case 'interface_declaration':
      return { kind: 'interface' };
    case 'type_alias_declaration':
      return { kind: 'type_alias' };
    case 'enum_declaration':
      return { kind: 'enum' };
    case 'internal_module':
    case 'module':
      return { kind: 'namespace' };
    case 'method_definition':
      return classifyMethodDef(node);
    case 'method_signature':
      return { kind: 'method' };
    case 'public_field_definition':
    case 'private_field_definition':
    case 'field_definition':
      return { kind: 'field' };
    case 'property_signature':
      return { kind: 'field' };
    default:
      return null;
  }
}

function getSymbolName(node: Parser.SyntaxNode): string | null {
  // Use tree-sitter named 'name' field when available (most reliable)
  const nameField = node.childForFieldName('name');
  if (nameField) return text(nameField);
  // Fallback: first identifier-like child
  const id = node.children.find(c =>
    c.type === 'identifier' ||
    c.type === 'type_identifier' ||
    c.type === 'property_identifier' ||
    c.type === 'private_property_identifier'
  );
  return id ? text(id) : null;
}

function getContainerBody(node: Parser.SyntaxNode, kind: string): Parser.SyntaxNode | null {
  switch (kind) {
    case 'class':
      return node.childForFieldName('body') ??
             node.children.find(c => c.type === 'class_body') ?? null;
    case 'interface':
      // tree-sitter-typescript uses 'object_type' for interface body
      return node.childForFieldName('body') ??
             node.children.find(c => c.type === 'object_type' || c.type === 'interface_body') ?? null;
    case 'enum':
      return node.children.find(c => c.type === 'enum_body') ?? null;
    case 'namespace':
      return node.childForFieldName('body') ??
             node.children.find(c => c.type === 'statement_block') ?? null;
    default:
      return null;
  }
}

// ─── Ref extraction ───────────────────────────────────────────────────────────

function extractCallee(node: Parser.SyntaxNode): string | null {
  if (node.type === 'identifier') return node.text;
  if (node.type === 'member_expression') {
    // For obj.method(), the 'property' field is the method name
    return node.childForFieldName('property')?.text ?? null;
  }
  return null;
}

function extractRefsFromBody(
  node: Parser.SyntaxNode,
  callerName: string,
  result: ExtractionResult
): void {
  function walk(n: Parser.SyntaxNode): void {
    // call_expression: foo(), obj.method(), foo?.()
    if (n.type === 'call_expression') {
      const fn = n.childForFieldName('function');
      if (fn) {
        const callee = extractCallee(fn);
        if (callee) result.refs.push({ callerName, calleeName: callee, kind: 'call' });
      }
    }

    // new_expression: new Foo()
    if (n.type === 'new_expression') {
      const ctor = n.childForFieldName('constructor');
      if (ctor) {
        const callee = extractCallee(ctor);
        if (callee) result.refs.push({ callerName, calleeName: callee, kind: 'call' });
      }
    }

    // JSX: <MyComponent /> or <MyComponent>. Capitalized names = component reference.
    if (n.type === 'jsx_opening_element' || n.type === 'jsx_self_closing_element') {
      const nameNode = n.childForFieldName('name');
      if (nameNode) {
        const tag = text(nameNode).split('.')[0]; // <Layout.Header> → "Layout"
        if (/^[A-Z]/.test(tag)) {
          result.refs.push({ callerName, calleeName: text(nameNode), kind: 'call' });
        }
      }
    }

    // TS type references: filter out primitives and utility types
    if (n.type === 'type_identifier') {
      const typeName = n.text;
      if (!PRIMITIVE_TYPES.has(typeName)) {
        result.refs.push({ callerName, calleeName: typeName, kind: 'type_reference' });
      }
    }

    for (const child of n.children) walk(child);
  }

  // Walk the entire function/method node to capture param types and body refs
  walk(node);
}

// ─── Symbol extraction ────────────────────────────────────────────────────────

function extractEnumMembers(
  enumBody: Parser.SyntaxNode,
  enumId: number,
  result: ExtractionResult,
  idCounter: { next: number }
): void {
  for (const child of enumBody.children) {
    let name: string | null = null;

    if (child.type === 'property_identifier') {
      name = text(child);
    } else if (child.type === 'enum_assignment') {
      const nameNode = child.children.find(c => c.type === 'property_identifier');
      name = nameNode ? text(nameNode) : null;
    }

    if (name) {
      const myId = idCounter.next++;
      result.symbols.push({
        name, kind: 'field',
        signature: null,
        parent_id: enumId,
        start_line: child.startPosition.row + 1,
        end_line: child.endPosition.row + 1,
        modifiers: [], annotations: [],
        _nodeId: myId,
      } as SymbolEntry);
    }
  }
}

function extractFromDeclarator(
  node: Parser.SyntaxNode, // variable_declarator
  varKind: string,
  parentId: number | null,
  result: ExtractionResult,
  idCounter: { next: number }
): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode || nameNode.type !== 'identifier') return;
  const name = text(nameNode);

  const valueNode = node.childForFieldName('value');
  const myId = idCounter.next++;

  if (
    valueNode?.type === 'arrow_function' ||
    valueNode?.type === 'function_expression' ||
    valueNode?.type === 'generator_function'
  ) {
    const modifiers: string[] = [varKind];
    if (valueNode.type === 'arrow_function') modifiers.push('arrow');
    if (valueNode.type === 'generator_function') modifiers.push('generator');
    result.symbols.push({
      name, kind: 'function',
      signature: buildFunctionSignature(name, valueNode),
      parent_id: parentId,
      start_line: node.startPosition.row + 1,
      end_line: node.endPosition.row + 1,
      modifiers, annotations: [],
      _nodeId: myId,
    } as SymbolEntry);
    extractRefsFromBody(valueNode, name, result);

  } else if (valueNode?.type === 'class' || valueNode?.type === 'class_expression') {
    // tree-sitter-javascript uses 'class' for class expressions; 'class_expression' is for TS
    result.symbols.push({
      name, kind: 'class',
      signature: null,
      parent_id: parentId,
      start_line: node.startPosition.row + 1,
      end_line: node.endPosition.row + 1,
      modifiers: [varKind], annotations: [],
      _nodeId: myId,
    } as SymbolEntry);
    const body = valueNode.children.find(c => c.type === 'class_body');
    if (body) {
      for (const child of body.children) {
        extractSymbolsFromNode(child, myId, result, idCounter);
      }
    }

  } else {
    result.symbols.push({
      name, kind: 'variable',
      signature: buildFieldSignature(name, node),
      parent_id: parentId,
      start_line: node.startPosition.row + 1,
      end_line: node.endPosition.row + 1,
      modifiers: [varKind], annotations: [],
      _nodeId: myId,
    } as SymbolEntry);
  }
}

function extractCJSExports(
  stmtNode: Parser.SyntaxNode, // expression_statement
  parentId: number | null,
  result: ExtractionResult,
  idCounter: { next: number }
): void {
  const expr = stmtNode.children.find(c => c.type === 'assignment_expression');
  if (!expr) return;

  const left = expr.childForFieldName('left');
  const right = expr.childForFieldName('right');
  if (!left || !right) return;

  let exportName: string | null = null;

  if (left.type === 'member_expression') {
    const obj = left.childForFieldName('object');
    const prop = left.childForFieldName('property');

    if (obj?.text === 'module' && prop?.text === 'exports') {
      exportName = 'default';
    } else if (obj?.text === 'exports' && prop) {
      exportName = prop.text;
    } else if (obj?.type === 'member_expression' && prop) {
      // module.exports.X = fn
      const innerObj = obj.childForFieldName('object');
      const innerProp = obj.childForFieldName('property');
      if (innerObj?.text === 'module' && innerProp?.text === 'exports') {
        exportName = prop.text;
      }
    }
  }

  if (!exportName) return;

  const myId = idCounter.next++;
  if (
    right.type === 'function_expression' ||
    right.type === 'arrow_function' ||
    right.type === 'generator_function'
  ) {
    result.symbols.push({
      name: exportName, kind: 'function',
      signature: buildFunctionSignature(exportName, right),
      parent_id: parentId,
      start_line: expr.startPosition.row + 1,
      end_line: expr.endPosition.row + 1,
      modifiers: ['export'], annotations: [],
      _nodeId: myId,
    } as SymbolEntry);
    extractRefsFromBody(right, exportName, result);

  } else if (right.type === 'class' || right.type === 'class_expression') {
    // tree-sitter-javascript uses 'class' for class expressions
    result.symbols.push({
      name: exportName, kind: 'class',
      signature: null,
      parent_id: parentId,
      start_line: expr.startPosition.row + 1,
      end_line: expr.endPosition.row + 1,
      modifiers: ['export'], annotations: [],
      _nodeId: myId,
    } as SymbolEntry);
    const body = right.children.find(c => c.type === 'class_body');
    if (body) {
      for (const c of body.children) extractSymbolsFromNode(c, myId, result, idCounter);
    }

  } else if (right.type !== 'identifier') {
    // Non-trivial RHS (object literal, expression): record as exported variable
    result.symbols.push({
      name: exportName, kind: 'variable',
      signature: null,
      parent_id: parentId,
      start_line: expr.startPosition.row + 1,
      end_line: expr.endPosition.row + 1,
      modifiers: ['export'], annotations: [],
      _nodeId: myId,
    } as SymbolEntry);
  }
}

function extractSymbolsFromNode(
  node: Parser.SyntaxNode,
  parentId: number | null,
  result: ExtractionResult,
  idCounter: { next: number }
): void {
  // expression_statement: check for CommonJS exports OR TS namespace declaration
  if (node.type === 'expression_statement') {
    // TS namespace/module declarations appear wrapped in expression_statement in tree-sitter-typescript
    const innerDecl = node.children.find(c => c.type === 'internal_module' || c.type === 'module');
    if (innerDecl) {
      extractSymbolsFromNode(innerDecl, parentId, result, idCounter);
    } else {
      extractCJSExports(node, parentId, result, idCounter);
    }
    return;
  }

  // export_statement: use named field access to find declaration/value reliably
  if (node.type === 'export_statement') {
    // Named export: 'export function foo(){}', 'export class Foo {}', 'export const x = 1'
    const declNode = node.childForFieldName('declaration');
    if (declNode) {
      extractSymbolsFromNode(declNode, parentId, result, idCounter);
      return;
    }

    // Default export: 'export default <something>'
    const valueNode = node.childForFieldName('value');
    if (valueNode) {
      // Named default: 'export default function foo() {}' → function_declaration with name
      if (valueNode.type.endsWith('_declaration') && getSymbolName(valueNode)) {
        extractSymbolsFromNode(valueNode, parentId, result, idCounter);
        return;
      }
      // Anonymous default: 'export default function() {}' → function_expression
      //                     'export default class {}' → class (JS class expression type)
      const isAnonFn = valueNode.type === 'function_expression' ||
                       valueNode.type === 'generator_function_expression';
      const isAnonClass = valueNode.type === 'class';
      if (isAnonFn || isAnonClass) {
        const symKind = isAnonClass ? 'class' : 'function';
        const myId = idCounter.next++;
        result.symbols.push({
          name: 'default', kind: symKind,
          signature: symKind === 'function' ? buildFunctionSignature('default', valueNode) : null,
          parent_id: parentId,
          start_line: valueNode.startPosition.row + 1,
          end_line: valueNode.endPosition.row + 1,
          modifiers: ['export'], annotations: [],
          _nodeId: myId,
        } as SymbolEntry);
        if (symKind === 'function') {
          extractRefsFromBody(valueNode, 'default', result);
        } else {
          const body = valueNode.children.find(c => c.type === 'class_body');
          if (body) {
            for (const c of body.children) extractSymbolsFromNode(c, myId, result, idCounter);
          }
        }
      }
      // 'export default <expr>' (identifier, call, etc.): no new symbol
      return;
    }

    // Re-export: 'export { a } from ...' or 'export * from ...' — no new symbols here
    return;
  }

  // lexical_declaration (const/let) and variable_declaration (var):
  // may contain multiple declarators — extract each separately
  if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
    const varKindNode = node.children.find(c =>
      c.type === 'const' || c.type === 'let' || c.type === 'var'
    );
    const varKind = varKindNode?.type ?? 'const';
    for (const child of node.children) {
      if (child.type === 'variable_declarator') {
        extractFromDeclarator(child, varKind, parentId, result, idCounter);
      }
    }
    return;
  }

  // Standard classification
  const classified = classifyNode(node);
  if (!classified) {
    // Unknown/container node — recurse into children to catch nested declarations
    for (const child of node.children) {
      extractSymbolsFromNode(child, parentId, result, idCounter);
    }
    return;
  }

  const { kind, modifiers: extraMods = [] } = classified;
  const name = getSymbolName(node);
  if (!name) return;

  const myId = idCounter.next++;
  // Deduplicate modifiers (classifyMethodDef may already include some from collectModifiers)
  const seen = new Set<string>();
  const modifiers = [...collectModifiers(node), ...extraMods].filter(v => !seen.has(v) && seen.add(v));

  let signature: string | null = null;
  if (['function', 'method', 'constructor', 'getter', 'setter'].includes(kind)) {
    signature = buildFunctionSignature(name, node);
  } else if (kind === 'field') {
    signature = buildFieldSignature(name, node);
  }

  result.symbols.push({
    name, kind, signature,
    parent_id: parentId,
    start_line: node.startPosition.row + 1,
    end_line: node.endPosition.row + 1,
    modifiers, annotations: [],
    _nodeId: myId,
  } as SymbolEntry);

  // Extract call/JSX/type refs from function and method bodies
  if (['function', 'method', 'constructor', 'getter', 'setter'].includes(kind)) {
    extractRefsFromBody(node, name, result);
  }

  // Recurse into container bodies (class/interface/enum/namespace members become children)
  const body = getContainerBody(node, kind);
  if (body) {
    if (kind === 'enum') {
      extractEnumMembers(body, myId, result, idCounter);
    } else {
      for (const child of body.children) {
        extractSymbolsFromNode(child, myId, result, idCounter);
      }
    }
  }
}

// ─── Dependency extraction ────────────────────────────────────────────────────

function extractDependencies(tree: Parser.Tree): ExtractedDependency[] {
  const deps: ExtractedDependency[] = [];
  const root = tree.rootNode;

  // ESM imports and re-exports with a source string
  for (const node of root.children) {
    if (node.type === 'import_statement') {
      const src = node.childForFieldName('source');
      if (src) deps.push({ targetFqn: src.text.replace(/^['"]|['"]$/g, ''), kind: 'import' });
    }
    if (node.type === 'export_statement') {
      const src = node.childForFieldName('source');
      if (src) deps.push({ targetFqn: src.text.replace(/^['"]|['"]$/g, ''), kind: 'import' });
    }
  }

  // Class extends / TS implements / interface extends — walk the full tree
  function walkInheritance(n: Parser.SyntaxNode): void {
    if (n.type === 'class_heritage') {
      // tree-sitter-typescript wraps extends/implements in separate clause nodes.
      // tree-sitter-javascript has the 'extends' keyword + superclass identifier directly.
      const extendsClause = n.children.find(c => c.type === 'extends_clause');
      if (extendsClause) {
        // TS style: superclass is the 'value' field of extends_clause
        const val = extendsClause.childForFieldName('value');
        if (val) {
          const name = val.type === 'generic_type'
            ? (val.childForFieldName('name')?.text ?? text(val))
            : text(val);
          deps.push({ targetFqn: name, kind: 'extends' });
        }
      } else {
        // JS style: 'extends' keyword followed by the superclass identifier
        const extendsIdx = n.children.findIndex(c => c.type === 'extends');
        if (extendsIdx >= 0) {
          const superNode = n.children.slice(extendsIdx + 1).find(c =>
            c.type === 'identifier' || c.type === 'type_identifier' ||
            c.type === 'member_expression'
          );
          if (superNode) deps.push({ targetFqn: text(superNode), kind: 'extends' });
        }
      }

      // TS implements_clause
      const implClause = n.children.find(c => c.type === 'implements_clause');
      if (implClause) {
        for (const child of implClause.children) {
          if (child.type === 'type_identifier' || child.type === 'identifier') {
            deps.push({ targetFqn: text(child), kind: 'implements' });
          } else if (child.type === 'generic_type') {
            const nm = child.childForFieldName('name');
            if (nm) deps.push({ targetFqn: text(nm), kind: 'implements' });
          }
        }
      }
      // Don't recurse further into class_heritage — already fully handled above
      return;
    }

    // TS interface: extends_type_clause lists parent interfaces
    if (n.type === 'extends_type_clause') {
      for (const child of n.children) {
        if (child.type === 'type_identifier' || child.type === 'identifier') {
          deps.push({ targetFqn: text(child), kind: 'extends' });
        } else if (child.type === 'generic_type') {
          const nm = child.childForFieldName('name');
          if (nm) deps.push({ targetFqn: text(nm), kind: 'extends' });
        }
      }
      return;
    }

    for (const child of n.children) walkInheritance(child);
  }
  walkInheritance(root);

  // CommonJS: const x = require('./y') anywhere in the file
  function walkCJS(n: Parser.SyntaxNode): void {
    if (n.type === 'call_expression') {
      const fn = n.childForFieldName('function');
      if (fn?.type === 'identifier' && fn.text === 'require') {
        const args = n.childForFieldName('arguments');
        const strArg = args?.children.find(c => c.type === 'string');
        if (strArg) {
          deps.push({ targetFqn: strArg.text.replace(/^['"]|['"]$/g, ''), kind: 'import' });
        }
      }
    }
    for (const child of n.children) walkCJS(child);
  }
  walkCJS(root);

  return deps;
}

// ─── Public API ───────────────────────────────────────────────────────────────

// The `language` parameter is available for future language-specific gating.
// Currently the tree-sitter grammar (javascript vs typescript vs tsx) handles
// all structural differences — JS/TS AST nodes that don't exist in a grammar
// simply never appear, so no explicit branching is needed here.
export function extractFromJS(
  tree: Parser.Tree,
  language: SupportedLanguage    // eslint-disable-line @typescript-eslint/no-unused-vars
): ExtractionResult {
  void language; // reserved for future TS-specific gating
  const result: ExtractionResult = { symbols: [], dependencies: [], refs: [] };
  const idCounter = { next: 0 };

  for (const child of tree.rootNode.children) {
    extractSymbolsFromNode(child, null, result, idCounter);
  }

  result.dependencies = extractDependencies(tree);
  return result;
}
