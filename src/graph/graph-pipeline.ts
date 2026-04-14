/**
 * Graph Build Pipeline — reads SQLite and populates the Kuzu graph database.
 *
 * Usage:
 *   const result = await buildGraph(db, projectId, graphStore, { verbose: true });
 *   // result: { nodes, edges, durationMs }
 *
 * Always performs a full rebuild: deleteByProject → insert nodes → insert edges.
 * Mirrors embed-pipeline.ts in structure.
 */
import type { Db } from '../storage/database.js';
import type { GraphStore, GraphNode, GraphEdge } from './graph-store.js';

// ─── BuildGraph ───────────────────────────────────────────────────────────────

export interface BuildGraphResult {
  nodes: number;
  edges: number;
  durationMs: number;
}

export async function buildGraph(
  db: Db,
  projectId: number,
  graphStore: GraphStore,
  opts: { verbose?: boolean } = {},
): Promise<BuildGraphResult> {
  const start = Date.now();

  // ── 1. Load all symbols for this project (bulk query) ────────────────────
  const symRows = db.prepare(`
    SELECT s.id, s.name, s.kind, s.parent_id, s.start_line, s.file_id,
           f.relative_path, p.root_path
    FROM symbols s
    JOIN files f ON s.file_id = f.id
    JOIN projects p ON f.project_id = p.id
    WHERE f.project_id = ?
    ORDER BY s.id
  `).all(projectId) as Array<{
    id: number; name: string; kind: string; parent_id: number | null;
    start_line: number; file_id: number; relative_path: string; root_path: string;
  }>;

  if (opts.verbose) {
    process.stdout.write(`  Loaded ${symRows.length} symbols from SQLite\n`);
  }

  // Build GraphNode array (file_path = root_path/relative_path)
  const nodes: GraphNode[] = symRows.map(r => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    filePath: `${r.root_path}/${r.relative_path}`,
    projectId,
    startLine: r.start_line,
  }));

  // ── 2. Build edges ────────────────────────────────────────────────────────
  const edges: GraphEdge[] = [];

  // 2a. CALLS / REFERENCES from the refs table (resolved IDs only)
  const refRows = db.prepare(`
    SELECT r.source_symbol_id, r.target_symbol_id, r.kind
    FROM refs r
    JOIN symbols src ON r.source_symbol_id = src.id
    JOIN files f ON src.file_id = f.id
    WHERE f.project_id = ?
      AND r.source_symbol_id IS NOT NULL
      AND r.target_symbol_id IS NOT NULL
  `).all(projectId) as Array<{
    source_symbol_id: number; target_symbol_id: number; kind: string;
  }>;

  for (const r of refRows) {
    if (r.kind === 'call') {
      edges.push({ fromId: r.source_symbol_id, toId: r.target_symbol_id, kind: 'CALLS' });
    } else {
      edges.push({
        fromId: r.source_symbol_id,
        toId: r.target_symbol_id,
        kind: 'REFERENCES',
        refKind: r.kind,
      });
    }
  }

  // 2b. CONTAINS — parent_id hierarchy
  for (const r of symRows) {
    if (r.parent_id !== null) {
      edges.push({ fromId: r.parent_id, toId: r.id, kind: 'CONTAINS' });
    }
  }

  // 2c. EXTENDS / IMPLEMENTS from dependencies table (best-effort name matching)
  const depRows = db.prepare(`
    SELECT d.source_file_id, d.kind, d.target_fqn
    FROM dependencies d
    JOIN files f ON d.source_file_id = f.id
    WHERE f.project_id = ?
      AND d.kind IN ('extends', 'implements')
  `).all(projectId) as Array<{
    source_file_id: number; kind: string; target_fqn: string;
  }>;

  if (depRows.length > 0) {
    // Map simple class name → symbol id (top-level classes/interfaces only)
    const classMap = new Map<string, number>();
    for (const r of symRows) {
      if (['class', 'interface', 'enum', 'record'].includes(r.kind) && r.parent_id === null) {
        classMap.set(r.name, r.id);
      }
    }

    // Map file_id → primary top-level class symbol id
    const fileToClass = new Map<number, number>();
    for (const r of symRows) {
      if (['class', 'interface', 'enum', 'record'].includes(r.kind) && r.parent_id === null) {
        if (!fileToClass.has(r.file_id)) fileToClass.set(r.file_id, r.id);
      }
    }

    for (const dep of depRows) {
      const sourceClassId = fileToClass.get(dep.source_file_id);
      if (sourceClassId === undefined) continue;

      // Extract simple name from FQN  (e.g. "com.example.Foo" → "Foo")
      const simpleName = dep.target_fqn.includes('.')
        ? dep.target_fqn.slice(dep.target_fqn.lastIndexOf('.') + 1)
        : dep.target_fqn;

      const targetId = classMap.get(simpleName);
      if (targetId === undefined) continue;
      if (targetId === sourceClassId) continue; // self-loop guard

      edges.push({
        fromId: sourceClassId,
        toId: targetId,
        kind: dep.kind === 'extends' ? 'EXTENDS' : 'IMPLEMENTS',
      });
    }
  }

  if (opts.verbose) {
    process.stdout.write(`  Built ${edges.length} edges (CALLS/REFERENCES/CONTAINS/EXTENDS/IMPLEMENTS)\n`);
    process.stdout.write('  Clearing existing graph for project...\n');
  }

  // ── 3. Full rebuild: delete old data, insert fresh ───────────────────────
  await graphStore.deleteByProject(projectId);

  if (opts.verbose) {
    process.stdout.write(`  Inserting ${nodes.length} nodes...\n`);
  }

  const { nodes: insertedNodes, edges: insertedEdges } = await graphStore.upsertBatch(nodes, edges);

  if (opts.verbose) {
    process.stdout.write(`  Inserted ${insertedNodes} nodes, ${insertedEdges} edges\n`);
  }

  return {
    nodes: insertedNodes,
    edges: insertedEdges,
    durationMs: Date.now() - start,
  };
}
