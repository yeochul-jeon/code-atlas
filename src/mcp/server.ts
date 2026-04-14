import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { openDatabase } from '../storage/database.js';
import type { Db } from '../storage/database.js';
import {
  listProjects,
  getProjectById,
  searchSymbolsFts,
  getSymbolsByFile,
  getSymbolById,
  getDependenciesByFile,
  getRefsByTargetSymbol,
  getFile,
  listProjectFiles,
  findDeadCode,
  type DeadCodeOptions,
} from '../storage/queries.js';
import { formatDeadCodeResult } from './dead-code-formatter.js';
import { replaceSymbolBody, insertAfterSymbol, insertBeforeSymbol, renameSymbol } from './write-tools.js';
import { Summarizer, getOrGenerateSummary } from '../summarizer/summarizer.js';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { loadConfig } from '../config/loader.js';
import { Embedder } from '../vectors/embedder.js';
import { VectorStore } from '../vectors/vector-store.js';
import { handleSemanticSearch } from '../vectors/semantic-search.js';
import { GraphStore } from '../graph/graph-store.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveFileRecord(db: Db, filePath: string) {
  const projects = listProjects(db);
  for (const p of projects) {
    if (filePath.startsWith(p.root_path)) {
      const rel = filePath.slice(p.root_path.length).replace(/^\//, '');
      const f = getFile(db, p.id, rel);
      if (f) return { file: f, project: p };
    }
  }
  return null;
}

function parseModifiers(raw: string | null): string[] {
  try { return raw ? JSON.parse(raw) : []; } catch { return []; }
}
function parseAnnotations(raw: string | null): string[] {
  try { return raw ? JSON.parse(raw) : []; } catch { return []; }
}

function readLines(filePath: string, start: number, end: number): string {
  if (!existsSync(filePath)) return `File not found: ${filePath}`;
  const lines = readFileSync(filePath, 'utf8').split('\n');
  return lines.slice(start - 1, end).join('\n');
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

export async function startMcpServer(dbPath: string, _httpPort?: number, modelOverride?: string): Promise<void> {
  const db = openDatabase(dbPath);
  const server = new McpServer({ name: 'codeatlas', version: '0.1.0' });

  // AI summarizer — uses ANTHROPIC_API_KEY env var; lazy-init so server starts even without key
  const DEFAULT_MODEL = modelOverride ?? 'claude-sonnet-4-6';
  let summarizer: Summarizer | null = null;
  function getSummarizer(): Summarizer {
    if (!summarizer) {
      summarizer = new Summarizer(new Anthropic(), { modelVersion: DEFAULT_MODEL });
    }
    return summarizer;
  }

  // Vector search — lazy-init; null if `codeatlas embed` has not been run
  let embedder: Embedder | null = null;
  let vectorStore: VectorStore | null = null;
  const vectorsPath = join(dirname(dbPath), 'vectors');

  function getEmbedder(): Embedder {
    if (!embedder) embedder = new Embedder();
    return embedder;
  }

  async function getVectorStore(): Promise<VectorStore | null> {
    if (vectorStore) return vectorStore;
    try {
      vectorStore = await VectorStore.open(vectorsPath);
      return vectorStore;
    } catch {
      return null;
    }
  }

  // Graph search — lazy-init; null if `codeatlas graph build` has not been run
  let graphStore: GraphStore | null = null;
  const graphPath = join(dirname(dbPath), 'graph.kuzu');

  async function getGraphStore(): Promise<GraphStore | null> {
    if (graphStore) return graphStore;
    try {
      graphStore = await GraphStore.open(graphPath);
      return graphStore;
    } catch {
      return null;
    }
  }

  // Resolve project by name or path (shared helper for semantic_search)
  function resolveProjectByName(name: string) {
    const projects = listProjects(db);
    return projects.find(p => p.name === name || p.root_path === name) ?? null;
  }

  // 1. list_projects
  server.tool('list_projects', 'List all indexed projects', {}, () => {
    const projects = listProjects(db);
    const text = projects.length === 0
      ? 'No projects indexed yet. Run: codeatlas index <path>'
      : projects.map(p => [
          `[${p.id}] ${p.name}`,
          `  path    : ${p.root_path}`,
          `  indexed : ${p.last_indexed_at ?? 'never'}`,
        ].join('\n')).join('\n\n');
    return { content: [{ type: 'text', text }] };
  });

  // 2. search_symbols
  server.tool(
    'search_symbols',
    'Search symbols by name across indexed projects',
    {
      query: z.string().describe('Symbol name or substring to search'),
      kind: z.enum(['class', 'interface', 'enum', 'method', 'field', 'constructor', 'record']).optional()
        .describe('Filter by symbol kind'),
      project: z.string().optional().describe('Filter by project name'),
      limit: z.number().int().positive().default(30).describe('Max results'),
    },
    ({ query, kind, project, limit }) => {
      let projectId: number | undefined;
      if (project) {
        const p = listProjects(db).find(x => x.name === project || x.root_path === project);
        if (!p) return { content: [{ type: 'text', text: `Project not found: ${project}` }] };
        projectId = p.id;
      }
      const results = searchSymbolsFts(db, query, kind, projectId, limit);
      if (!results.length) return { content: [{ type: 'text', text: 'No symbols found.' }] };

      const text = results.map(r => {
        const mods = parseModifiers(r.modifiers).join(' ');
        const anns = parseAnnotations(r.annotations).join(' ');
        return [
          `[${r.kind}] ${mods ? mods + ' ' : ''}${r.signature ?? r.name}`,
          anns ? `  annotations: ${anns}` : '',
          `  file: ${r.root_path}/${r.relative_path}:${r.start_line}`,
          `  project: ${r.project_name}`,
        ].filter(Boolean).join('\n');
      }).join('\n\n');
      return { content: [{ type: 'text', text }] };
    }
  );

  // 3. get_file_overview
  server.tool(
    'get_file_overview',
    'Get symbol tree for a file (classes, methods, fields)',
    { file_path: z.string().describe('Absolute path to the file') },
    ({ file_path }) => {
      const resolved = resolveFileRecord(db, file_path);
      if (!resolved) return { content: [{ type: 'text', text: `File not indexed: ${file_path}` }] };

      const symbols = getSymbolsByFile(db, resolved.file.id);
      if (!symbols.length) return { content: [{ type: 'text', text: 'No symbols found in file.' }] };

      const byId = new Map(symbols.map(s => [s.id, s]));
      const roots = symbols.filter(s => s.parent_id === null);

      function renderTree(sym: typeof symbols[0], depth: number): string {
        const indent = '  '.repeat(depth);
        const mods = parseModifiers(sym.modifiers).join(' ');
        const anns = parseAnnotations(sym.annotations);
        const annStr = anns.length ? anns.join(' ') + ' ' : '';
        const sig = sym.signature ?? sym.name;
        const header = `${indent}[${sym.kind}] ${annStr}${mods ? mods + ' ' : ''}${sig} (L${sym.start_line}-${sym.end_line})`;
        const children = symbols.filter(s => s.parent_id === sym.id);
        return [header, ...children.map(c => renderTree(c, depth + 1))].join('\n');
      }

      const text = roots.map(r => renderTree(r, 0)).join('\n');
      return { content: [{ type: 'text', text }] };
    }
  );

  // 4. get_symbol_detail
  server.tool(
    'get_symbol_detail',
    'Get detailed information about a symbol',
    {
      file_path: z.string().describe('Absolute path to the file'),
      symbol_name: z.string().describe('Name of the symbol'),
    },
    ({ file_path, symbol_name }) => {
      const resolved = resolveFileRecord(db, file_path);
      if (!resolved) return { content: [{ type: 'text', text: `File not indexed: ${file_path}` }] };

      const symbols = getSymbolsByFile(db, resolved.file.id);
      const sym = symbols.find(s => s.name === symbol_name);
      if (!sym) return { content: [{ type: 'text', text: `Symbol not found: ${symbol_name}` }] };

      const parent = sym.parent_id ? byId(sym.parent_id) : null;
      const children = symbols.filter(s => s.parent_id === sym.id);
      const refs = getRefsByTargetSymbol(db, sym.id);

      function byId(id: number) { return symbols.find(s => s.id === id) ?? null; }

      const lines = [
        `Name      : ${sym.name}`,
        `Kind      : ${sym.kind}`,
        `Signature : ${sym.signature ?? '—'}`,
        `Location  : L${sym.start_line}–${sym.end_line}`,
        `Modifiers : ${parseModifiers(sym.modifiers).join(', ') || '—'}`,
        `Annotations: ${parseAnnotations(sym.annotations).join(', ') || '—'}`,
        `Parent    : ${parent?.name ?? '—'}`,
        `Children  : ${children.map(c => `${c.name}(${c.kind})`).join(', ') || '—'}`,
        `References: ${refs.length} incoming refs`,
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  // 5. get_dependencies
  server.tool(
    'get_dependencies',
    'Get import/extends/implements dependencies for a file',
    { file_path: z.string().describe('Absolute path to the file') },
    ({ file_path }) => {
      const resolved = resolveFileRecord(db, file_path);
      if (!resolved) return { content: [{ type: 'text', text: `File not indexed: ${file_path}` }] };

      const deps = getDependenciesByFile(db, resolved.file.id);
      if (!deps.length) return { content: [{ type: 'text', text: 'No dependencies found.' }] };

      const grouped: Record<string, string[]> = {};
      for (const d of deps) {
        (grouped[d.kind] ??= []).push(d.target_fqn);
      }
      const text = Object.entries(grouped)
        .map(([kind, fqns]) => `${kind}:\n${fqns.map(f => `  ${f}`).join('\n')}`)
        .join('\n\n');
      return { content: [{ type: 'text', text }] };
    }
  );

  // 6. find_implementors
  server.tool(
    'find_implementors',
    'Find classes that implement a given interface',
    {
      interface_name: z.string().describe('Interface name or FQN'),
      project: z.string().optional().describe('Limit to project name'),
    },
    ({ interface_name, project }) => {
      const projects = project
        ? listProjects(db).filter(p => p.name === project)
        : listProjects(db);

      const results: string[] = [];
      for (const p of projects) {
        const files = listProjectFiles(db, p.id);
        for (const f of files) {
          const deps = getDependenciesByFile(db, f.id);
          const impl = deps.filter(d =>
            d.kind === 'implements' &&
            (d.target_fqn === interface_name || d.target_fqn.endsWith('.' + interface_name))
          );
          if (impl.length) {
            const symbols = getSymbolsByFile(db, f.id);
            const classes = symbols.filter(s => s.kind === 'class' && s.parent_id === null);
            for (const c of classes) {
              results.push(`${c.name} — ${p.root_path}/${f.relative_path}:${c.start_line}`);
            }
          }
        }
      }

      const text = results.length
        ? results.join('\n')
        : `No implementors found for: ${interface_name}`;
      return { content: [{ type: 'text', text }] };
    }
  );

  // 7. get_package_tree
  server.tool(
    'get_package_tree',
    'Get package hierarchy tree for a project',
    {
      project: z.string().optional().describe('Project name'),
      depth: z.number().int().min(1).max(10).default(4).describe('Max depth'),
    },
    ({ project, depth }) => {
      const projects = project
        ? listProjects(db).filter(p => p.name === project)
        : listProjects(db);

      const lines: string[] = [];
      for (const p of projects) {
        lines.push(`[${p.name}]`);
        const files = listProjectFiles(db, p.id);
        const tree: Record<string, unknown> = {};

        for (const f of files) {
          const parts = f.relative_path.split('/');
          let node = tree;
          for (const part of parts.slice(0, depth)) {
            node[part] ??= {};
            node = node[part] as Record<string, unknown>;
          }
        }

        function renderNode(obj: Record<string, unknown>, indent: number): void {
          for (const [key, val] of Object.entries(obj)) {
            lines.push('  '.repeat(indent) + key);
            if (typeof val === 'object' && val !== null) {
              renderNode(val as Record<string, unknown>, indent + 1);
            }
          }
        }
        renderNode(tree, 1);
      }

      return { content: [{ type: 'text', text: lines.join('\n') || 'No projects indexed.' }] };
    }
  );

  // 8. get_symbol_references
  server.tool(
    'get_symbol_references',
    'Find all reference locations for a symbol',
    {
      symbol_name: z.string().describe('Symbol name'),
      project: z.string().optional().describe('Limit to project name'),
    },
    ({ symbol_name, project }) => {
      const projects = project
        ? listProjects(db).filter(p => p.name === project)
        : listProjects(db);

      const results: string[] = [];
      for (const p of projects) {
        const files = listProjectFiles(db, p.id);
        for (const f of files) {
          const symbols = getSymbolsByFile(db, f.id);
          const target = symbols.find(s => s.name === symbol_name);
          if (!target) continue;
          const refs = getRefsByTargetSymbol(db, target.id);
          for (const ref of refs) {
            const src = ref.source_symbol_id ? getSymbolById(db, ref.source_symbol_id) : null;
            results.push(
              `${ref.kind} from ${src?.name ?? '?'} — ${p.root_path}/${f.relative_path}`
            );
          }
        }
      }

      const text = results.length
        ? results.join('\n')
        : `No references found for: ${symbol_name}`;
      return { content: [{ type: 'text', text }] };
    }
  );

  // 9. read_symbol_body
  server.tool(
    'read_symbol_body',
    'Read the source code of a specific symbol',
    {
      file_path: z.string().describe('Absolute path to the file'),
      symbol_name: z.string().describe('Name of the symbol'),
    },
    ({ file_path, symbol_name }) => {
      const resolved = resolveFileRecord(db, file_path);
      if (!resolved) return { content: [{ type: 'text', text: `File not indexed: ${file_path}` }] };

      const symbols = getSymbolsByFile(db, resolved.file.id);
      const sym = symbols.find(s => s.name === symbol_name);
      if (!sym) return { content: [{ type: 'text', text: `Symbol not found: ${symbol_name}` }] };

      const body = readLines(file_path, sym.start_line, sym.end_line);
      return { content: [{ type: 'text', text: body }] };
    }
  );

  // 10. read_file_range
  server.tool(
    'read_file_range',
    'Read a specific line range from a file',
    {
      file_path: z.string().describe('Absolute path to the file'),
      start_line: z.number().int().positive().describe('Start line (1-based)'),
      end_line: z.number().int().positive().describe('End line (inclusive)'),
    },
    ({ file_path, start_line, end_line }) => {
      const text = readLines(file_path, start_line, end_line);
      return { content: [{ type: 'text', text }] };
    }
  );

  // 11. find_dead_code
  server.tool(
    'find_dead_code',
    'Find potentially dead (unreferenced) symbols in a project. Excludes Spring/framework-annotated classes, @Override methods, main(), and public static final constants.',
    {
      project: z.string().optional().describe('Project name or root path (omit to search all)'),
      kind: z.enum(['class', 'interface', 'enum', 'method', 'field']).optional()
        .describe('Filter by symbol kind'),
    },
    ({ project, kind }) => {
      const projects = project
        ? listProjects(db).filter(p => p.name === project || p.root_path === project)
        : listProjects(db);

      if (projects.length === 0) {
        return { content: [{ type: 'text', text: project ? `Project not found: ${project}` : 'No projects indexed yet.' }] };
      }

      const allDead = projects.flatMap(p => {
        const cfg = loadConfig(p.root_path);
        const opts: DeadCodeOptions = {
          excludeAnnotations: new Set(cfg.deadCode.excludeAnnotations),
          excludePatterns: cfg.deadCode.excludePatterns,
        };
        return findDeadCode(db, p.id, kind, opts);
      });
      const text = formatDeadCodeResult(allDead);
      return { content: [{ type: 'text', text }] };
    }
  );

  // ── AI summary (lazy generation) ──────────────────────────────────────────────

  server.tool(
    'get_file_summary',
    'Get an AI-generated summary for a source file. Generated on first call and cached in the database. Call again with the same file to get the cached result instantly.',
    {
      file_path: z.string().describe('Absolute path to the Java/Kotlin file'),
    },
    async ({ file_path }) => {
      const resolved = resolveFileRecord(db, file_path);
      if (!resolved) {
        return { content: [{ type: 'text', text: `File not indexed: ${file_path}` }] };
      }
      const { file } = resolved;
      let source: string;
      try {
        source = readFileSync(file_path, 'utf8');
      } catch {
        return { content: [{ type: 'text', text: `Cannot read file: ${file_path}` }] };
      }
      const symbols = getSymbolsByFile(db, file.id).map(s => ({ name: s.name, kind: s.kind }));
      try {
        const summary = await getOrGenerateSummary(
          db, file.id, file_path, source, symbols, getSummarizer(), DEFAULT_MODEL,
        );
        return { content: [{ type: 'text', text: summary }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Failed to generate summary: ${(err as Error).message}` }] };
      }
    }
  );

  // ── Write tools (Serena replacement) ─────────────────────────────────────────

  server.tool(
    'replace_symbol_body',
    'Replace the entire body of a symbol (class, method, field) with new content. Verifies symbol position before writing, then atomically writes and re-indexes the file.',
    {
      file_path: z.string().describe('Absolute path to the Java/Kotlin file'),
      symbol_name: z.string().describe('Name of the symbol to replace'),
      new_content: z.string().describe('New source text to replace the symbol with (must include the full declaration)'),
    },
    ({ file_path, symbol_name, new_content }) => {
      const result = replaceSymbolBody(db, file_path, symbol_name, new_content);
      const text = result.success
        ? `Successfully replaced '${symbol_name}' in ${file_path}`
        : `Error: ${result.error}`;
      return { content: [{ type: 'text', text }] };
    }
  );

  server.tool(
    'insert_after_symbol',
    'Insert content immediately after the end of a symbol. Atomically writes and re-indexes the file.',
    {
      file_path: z.string().describe('Absolute path to the Java/Kotlin file'),
      symbol_name: z.string().describe('Name of the symbol to insert after'),
      content: z.string().describe('Source text to insert (e.g., a new method declaration)'),
    },
    ({ file_path, symbol_name, content }) => {
      const result = insertAfterSymbol(db, file_path, symbol_name, content);
      const text = result.success
        ? `Successfully inserted content after '${symbol_name}' in ${file_path}`
        : `Error: ${result.error}`;
      return { content: [{ type: 'text', text }] };
    }
  );

  server.tool(
    'insert_before_symbol',
    'Insert content immediately before the start of a symbol. Atomically writes and re-indexes the file.',
    {
      file_path: z.string().describe('Absolute path to the Java/Kotlin file'),
      symbol_name: z.string().describe('Name of the symbol to insert before'),
      content: z.string().describe('Source text to insert (e.g., a new method declaration)'),
    },
    ({ file_path, symbol_name, content }) => {
      const result = insertBeforeSymbol(db, file_path, symbol_name, content);
      const text = result.success
        ? `Successfully inserted content before '${symbol_name}' in ${file_path}`
        : `Error: ${result.error}`;
      return { content: [{ type: 'text', text }] };
    }
  );

  server.tool(
    'rename_symbol',
    'Text-based rename of a symbol across all files in its project. Uses word-boundary matching to avoid partial renames. Not type-aware (may miss dynamic dispatch or reflection).',
    {
      file_path: z.string().describe('Absolute path to the file declaring the symbol'),
      symbol_name: z.string().describe('Current symbol name'),
      new_name: z.string().describe('New symbol name'),
    },
    ({ file_path, symbol_name, new_name }) => {
      const result = renameSymbol(db, file_path, symbol_name, new_name);
      const text = result.success
        ? `Successfully renamed '${symbol_name}' → '${new_name}'. Changed files:\n${result.changedFiles?.join('\n') ?? 'none'}`
        : `Error: ${result.error}`;
      return { content: [{ type: 'text', text }] };
    }
  );

  // ── Semantic search (vector) ─────────────────────────────────────────────────

  server.tool(
    'semantic_search',
    'Search code by natural language meaning rather than exact keyword match. Requires embeddings to be generated first (run `codeatlas embed <project>`).',
    {
      query: z.string().describe('Natural language query, e.g. "authentication middleware" or "handles payment processing"'),
      project: z.string().optional().describe('Filter by project name (from list_projects)'),
      kind: z.enum(['file', 'symbol']).optional().default('file').describe('"file" searches file-level summaries; "symbol" searches class/interface/enum level'),
      limit: z.number().int().positive().default(10).describe('Maximum number of results'),
    },
    async ({ query, project, kind, limit }) => {
      const store = await getVectorStore();
      const text = await handleSemanticSearch(
        { query, project, kind, limit },
        getEmbedder(),
        store,
        resolveProjectByName,
      );
      return { content: [{ type: 'text', text }] };
    }
  );

  // ── Graph tools (Phase 6) ────────────────────────────────────────────────────

  // 18. get_impact_analysis
  server.tool(
    'get_impact_analysis',
    'Find all symbols that directly or transitively call/reference a given symbol. ' +
    'Use this to assess the impact of changing a class or method. ' +
    'Requires graph to be built first (run `codeatlas graph build <project>`).',
    {
      symbol: z.string().describe('Symbol name to analyse (class, method, or field name)'),
      project: z.string().describe('Project name (from list_projects)'),
      depth: z.number().int().min(1).max(6).default(3)
        .describe('Max traversal depth (1–6, default 3)'),
    },
    async ({ symbol, project, depth }) => {
      const store = await getGraphStore();
      if (!store) {
        return {
          content: [{
            type: 'text',
            text: 'Graph not built. Run: codeatlas graph build <project>',
          }],
        };
      }

      const proj = resolveProjectByName(project);
      if (!proj) {
        return { content: [{ type: 'text', text: `Project not found: ${project}` }] };
      }

      const results = await store.queryImpact(symbol, proj.id, depth);

      if (results.length === 0) {
        return {
          content: [{
            type: 'text',
            text: `No callers found for '${symbol}' within depth ${depth}.`,
          }],
        };
      }

      const lines = [
        `Impact analysis for '${symbol}' (depth ≤ ${depth}) — ${results.length} caller(s):`,
        '',
        ...results.map(r =>
          `[${r.kind}] ${r.name}\n  ${r.filePath}:${r.startLine}`,
        ),
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // 19. find_circular_deps
  server.tool(
    'find_circular_deps',
    'Detect classes or interfaces that form inheritance cycles via extends/implements. ' +
    'Returns all symbols involved in a cycle. ' +
    'Requires graph to be built first (run `codeatlas graph build <project>`).',
    {
      project: z.string().describe('Project name (from list_projects)'),
      edge_kind: z.enum(['extends', 'implements', 'all']).default('all')
        .describe('Which inheritance edge type to check'),
    },
    async ({ project, edge_kind }) => {
      const store = await getGraphStore();
      if (!store) {
        return {
          content: [{
            type: 'text',
            text: 'Graph not built. Run: codeatlas graph build <project>',
          }],
        };
      }

      const proj = resolveProjectByName(project);
      if (!proj) {
        return { content: [{ type: 'text', text: `Project not found: ${project}` }] };
      }

      const results = await store.queryCircularDeps(proj.id, edge_kind);

      if (results.length === 0) {
        return {
          content: [{
            type: 'text',
            text: `No circular ${edge_kind === 'all' ? 'extends/implements' : edge_kind} dependencies found in '${project}'.`,
          }],
        };
      }

      const lines = [
        `Circular inheritance detected in '${project}' — ${results.length} symbol(s) involved:`,
        '',
        ...results.map(r => `[${r.kind}] ${r.name}\n  ${r.filePath}`),
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // ── Start transport ──────────────────────────────────────────────────────────
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('CodeAtlas MCP server running (stdio)\n');
}
