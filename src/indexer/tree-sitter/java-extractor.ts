import type Parser from 'tree-sitter';
import type { InsertSymbolParams } from '../../storage/queries.js';

export interface ExtractedDependency {
  targetFqn: string;
  kind: 'import' | 'extends' | 'implements';
}

export interface ExtractedRef {
  callerName: string;
  calleeName: string;
  kind: 'call' | 'field_access' | 'type_reference' | 'annotation';
}

export interface ExtractionResult {
  symbols: Omit<InsertSymbolParams, 'file_id'>[];
  dependencies: ExtractedDependency[];
  refs: ExtractedRef[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function text(node: Parser.SyntaxNode): string {
  return node.text.trim();
}

function childText(node: Parser.SyntaxNode, type: string): string | null {
  const child = node.children.find(c => c.type === type);
  return child ? text(child) : null;
}

function collectAnnotations(node: Parser.SyntaxNode): string[] {
  const result: string[] = [];
  for (const child of node.children) {
    if (child.type === 'marker_annotation' || child.type === 'annotation') {
      const name = child.children.find(c => c.type === 'identifier');
      result.push(name ? `@${text(name)}` : text(child));
    } else if (child.type === 'modifiers') {
      // Annotations are children of the modifiers node in tree-sitter-java
      for (const mod of child.children) {
        if (mod.type === 'marker_annotation' || mod.type === 'annotation') {
          const name = mod.children.find(c => c.type === 'identifier');
          result.push(name ? `@${text(name)}` : text(mod));
        }
      }
    }
  }
  return result;
}

function collectModifiers(node: Parser.SyntaxNode): string[] {
  const modNode = node.children.find(c => c.type === 'modifiers');
  if (!modNode) return [];
  return modNode.children
    .filter(c => ['public', 'private', 'protected', 'static', 'final',
      'abstract', 'synchronized', 'native', 'transient', 'volatile',
      'default', 'strictfp'].includes(c.type))
    .map(c => c.type);
}

function buildMethodSignature(node: Parser.SyntaxNode): string {
  const name = childText(node, 'identifier') ?? '?';
  const params = node.children.find(c => c.type === 'formal_parameters');
  const returnType = node.children.find(
    c => c !== params && (c.type.includes('type') || c.type === 'void_type')
  );
  const paramStr = params ? text(params) : '()';
  const retStr = returnType ? text(returnType) + ' ' : '';
  return `${retStr}${name}${paramStr}`;
}

function buildConstructorSignature(node: Parser.SyntaxNode): string {
  const name = childText(node, 'identifier') ?? '?';
  const params = node.children.find(c => c.type === 'formal_parameters');
  return `${name}${params ? text(params) : '()'}`;
}

function buildFieldSignature(node: Parser.SyntaxNode): string {
  const type = node.children.find(c => c.type.includes('type'));
  const declarators = node.children.find(c => c.type === 'variable_declarator');
  const name = declarators ? text(declarators).split('=')[0].trim() : '?';
  return type ? `${text(type)} ${name}` : name;
}

// ─── Recursive symbol extraction ──────────────────────────────────────────────

interface SymbolEntry extends Omit<InsertSymbolParams, 'file_id'> {
  _nodeId?: number;
}

function extractSymbolsFromNode(
  node: Parser.SyntaxNode,
  parentId: number | null,
  result: ExtractionResult,
  idCounter: { next: number }
): void {
  const kind = classifyNode(node);
  if (!kind) {
    for (const child of node.children) {
      extractSymbolsFromNode(child, parentId, result, idCounter);
    }
    return;
  }

  const name = getSymbolName(node, kind);
  if (!name) return;

  const myId = idCounter.next++;
  const entry: SymbolEntry = {
    name,
    kind,
    signature: buildSignature(node, kind),
    parent_id: parentId,
    start_line: node.startPosition.row + 1,
    end_line: node.endPosition.row + 1,
    modifiers: collectModifiers(node),
    annotations: collectAnnotations(node),
    _nodeId: myId,
  };
  result.symbols.push(entry);

  // Extract call references from method/constructor bodies
  if (kind === 'method' || kind === 'constructor') {
    extractRefsFromBody(node, name, result);
  }

  // Recurse into class/interface/enum bodies
  if (['class', 'interface', 'enum'].includes(kind)) {
    const body = node.children.find(c =>
      c.type === 'class_body' || c.type === 'interface_body' || c.type === 'enum_body'
    );
    if (body) {
      for (const child of body.children) {
        extractSymbolsFromNode(child, myId, result, idCounter);
      }
    }
  }
}

function classifyNode(node: Parser.SyntaxNode): string | null {
  switch (node.type) {
    case 'class_declaration': return 'class';
    case 'interface_declaration': return 'interface';
    case 'enum_declaration': return 'enum';
    case 'method_declaration': return 'method';
    case 'constructor_declaration': return 'constructor';
    case 'field_declaration': return 'field';
    case 'annotation_type_declaration': return 'annotation_type';
    case 'record_declaration': return 'record';
    default: return null;
  }
}

function getSymbolName(node: Parser.SyntaxNode, kind: string): string | null {
  if (kind === 'field') {
    const decl = node.children.find(c => c.type === 'variable_declarator');
    if (!decl) return null;
    const id = decl.children.find(c => c.type === 'identifier');
    return id ? text(id) : null;
  }
  const id = node.children.find(c => c.type === 'identifier');
  return id ? text(id) : null;
}

function buildSignature(node: Parser.SyntaxNode, kind: string): string | null {
  switch (kind) {
    case 'method': return buildMethodSignature(node);
    case 'constructor': return buildConstructorSignature(node);
    case 'field': return buildFieldSignature(node);
    default: return null;
  }
}

function extractRefsFromBody(
  node: Parser.SyntaxNode,
  callerName: string,
  result: ExtractionResult
): void {
  function walk(n: Parser.SyntaxNode): void {
    if (n.type === 'method_invocation') {
      // For `obj.method()`, there are multiple identifiers: [obj, method].
      // The method name is always the LAST identifier child.
      const identifiers = n.children.filter(c => c.type === 'identifier');
      const nameNode = identifiers[identifiers.length - 1];
      if (nameNode) {
        result.refs.push({ callerName, calleeName: text(nameNode), kind: 'call' });
      }
    }
    for (const child of n.children) walk(child);
  }
  const body = node.children.find(c => c.type === 'block');
  if (body) walk(body);
}

// ─── Dependency extraction ────────────────────────────────────────────────────

function extractDependencies(tree: Parser.Tree): ExtractedDependency[] {
  const deps: ExtractedDependency[] = [];
  const root = tree.rootNode;

  // imports
  for (const node of root.children) {
    if (node.type === 'import_declaration') {
      const name = node.children.find(c => c.type === 'scoped_identifier' || c.type === 'identifier');
      if (name) deps.push({ targetFqn: text(name), kind: 'import' });
    }
  }

  // extends / implements on top-level classes
  function walkForInheritance(n: Parser.SyntaxNode): void {
    if (n.type === 'superclass') {
      const t = n.children.find(c => c.type !== 'extends');
      if (t) deps.push({ targetFqn: text(t), kind: 'extends' });
    }
    if (n.type === 'super_interfaces' || n.type === 'extends_interfaces') {
      // tree-sitter-java uses 'type_list' (or 'interface_type_list' in older grammars)
      const list = n.children.find(c => c.type === 'type_list' || c.type === 'interface_type_list');
      if (list) {
        for (const t of list.children.filter(c => c.type !== ',' && c.type !== 'implements' && c.type !== 'extends')) {
          deps.push({ targetFqn: text(t), kind: 'implements' });
        }
      }
    }
    for (const child of n.children) walkForInheritance(child);
  }
  walkForInheritance(root);

  return deps;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function extractFromJava(tree: Parser.Tree): ExtractionResult {
  const result: ExtractionResult = { symbols: [], dependencies: [], refs: [] };
  const idCounter = { next: 0 };

  const root = tree.rootNode;
  for (const child of root.children) {
    extractSymbolsFromNode(child, null, result, idCounter);
  }

  result.dependencies = extractDependencies(tree);
  return result;
}
