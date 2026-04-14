/**
 * GraphStore — Kuzu graph database wrapper for code graph queries.
 *
 * Mirrors the VectorStore pattern:
 *   const store = await GraphStore.open('~/.codeatlas/graph');
 *   await store.upsertBatch(nodes, edges);
 *   const impacts = await store.queryImpact('UserService', projectId, 3);
 */
import kuzu from 'kuzu';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { ALL_DDL } from './schema.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GraphNode {
  id: number;
  name: string;
  kind: string;
  filePath: string;
  projectId: number;
  startLine: number;
}

export type EdgeKind = 'CALLS' | 'REFERENCES' | 'EXTENDS' | 'IMPLEMENTS' | 'CONTAINS';

export interface GraphEdge {
  fromId: number;
  toId: number;
  kind: EdgeKind;
  /** Only used for REFERENCES edges */
  refKind?: string;
}

export interface ImpactResult {
  id: number;
  name: string;
  kind: string;
  filePath: string;
  startLine: number;
  depth: number;
}

export interface CircularDepResult {
  name: string;
  kind: string;
  filePath: string;
}

export interface GraphBuildStats {
  nodes: number;
  edges: number;
  durationMs: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Close a QueryResult (handles single or array return from conn.query) */
async function closeResult(res: kuzu.QueryResult | kuzu.QueryResult[]): Promise<void> {
  if (Array.isArray(res)) {
    for (const r of res) r.close();
  } else {
    res.close();
  }
}

/** Get rows from a QueryResult */
async function getRows(
  res: kuzu.QueryResult | kuzu.QueryResult[],
): Promise<Record<string, kuzu.KuzuValue>[]> {
  const r = Array.isArray(res) ? res[0] : res;
  const rows = await r.getAll();
  r.close();
  return rows;
}

// Batch size for transactions
const BATCH_SIZE = 2000;

// ─── GraphStore ───────────────────────────────────────────────────────────────

export class GraphStore {
  private constructor(
    private readonly db: kuzu.Database,
    private readonly conn: kuzu.Connection,
  ) {}

  /**
   * Open (or create) a Kuzu graph database at `dbPath`.
   * In Kuzu v0.11+, the database is a single file — `dbPath` is the file path,
   * not a directory. The parent directory is created if it doesn't exist.
   */
  static async open(dbPath: string): Promise<GraphStore> {
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new kuzu.Database(dbPath);
    const conn = new kuzu.Connection(db);
    const store = new GraphStore(db, conn);
    await store.ensureSchema();
    return store;
  }

  /** Create node/rel tables if they don't exist yet */
  private async ensureSchema(): Promise<void> {
    for (const ddl of ALL_DDL) {
      const res = await this.conn.query(ddl);
      await closeResult(res);
    }
  }

  /**
   * Delete all Symbol nodes (and their edges) for a project.
   * Must be called before re-building the graph for the project.
   */
  async deleteByProject(projectId: number): Promise<void> {
    const res = await this.conn.query(
      `MATCH (n:Symbol) WHERE n.project_id = ${projectId} DETACH DELETE n`,
    );
    await closeResult(res);
  }

  /**
   * Insert or update nodes and edges in batches.
   * Nodes MUST be inserted before edges.
   * Returns counts of what was inserted.
   */
  async upsertBatch(nodes: GraphNode[], edges: GraphEdge[]): Promise<{ nodes: number; edges: number }> {
    // Prepare once, reuse per batch
    const nodeStmt = await this.conn.prepare(`
      MERGE (s:Symbol {id: $id})
      ON CREATE SET s.name = $name, s.kind = $kind, s.file_path = $fp, s.project_id = $pid, s.start_line = $sl
      ON MATCH  SET s.name = $name, s.kind = $kind, s.file_path = $fp, s.project_id = $pid, s.start_line = $sl
    `);

    // Insert nodes in batched transactions
    for (let i = 0; i < nodes.length; i += BATCH_SIZE) {
      const chunk = nodes.slice(i, i + BATCH_SIZE);
      const txRes = await this.conn.query('BEGIN TRANSACTION');
      await closeResult(txRes);

      for (const n of chunk) {
        const res = await this.conn.execute(nodeStmt, {
          id: n.id,
          name: n.name,
          kind: n.kind,
          fp: n.filePath,
          pid: n.projectId,
          sl: n.startLine,
        });
        await closeResult(res);
      }

      const commitRes = await this.conn.query('COMMIT');
      await closeResult(commitRes);
    }

    // Prepare edge statements per kind
    const edgeStmts: Map<string, kuzu.PreparedStatement> = new Map();
    for (const kind of ['CALLS', 'REFERENCES', 'EXTENDS', 'IMPLEMENTS', 'CONTAINS'] as const) {
      if (kind === 'REFERENCES') {
        edgeStmts.set(kind, await this.conn.prepare(`
          MATCH (a:Symbol {id: $from}), (b:Symbol {id: $to})
          CREATE (a)-[:REFERENCES {kind: $kind}]->(b)
        `));
      } else {
        edgeStmts.set(kind, await this.conn.prepare(`
          MATCH (a:Symbol {id: $from}), (b:Symbol {id: $to})
          CREATE (a)-[:${kind}]->(b)
        `));
      }
    }

    let edgesInserted = 0;

    // Insert edges in batched transactions
    for (let i = 0; i < edges.length; i += BATCH_SIZE) {
      const chunk = edges.slice(i, i + BATCH_SIZE);
      const txRes = await this.conn.query('BEGIN TRANSACTION');
      await closeResult(txRes);

      for (const e of chunk) {
        const stmt = edgeStmts.get(e.kind);
        if (!stmt) continue;
        try {
          const params: Record<string, kuzu.KuzuValue> = { from: e.fromId, to: e.toId };
          if (e.kind === 'REFERENCES') params['kind'] = e.refKind ?? 'unknown';
          const res = await this.conn.execute(stmt, params);
          await closeResult(res);
          edgesInserted++;
        } catch {
          // Skip edges where one endpoint doesn't exist (unresolved cross-project refs)
        }
      }

      const commitRes = await this.conn.query('COMMIT');
      await closeResult(commitRes);
    }

    return { nodes: nodes.length, edges: edgesInserted };
  }

  /**
   * Reverse impact analysis: find all callers/referencers of a symbol.
   * Traverses up to `depth` hops of CALLS + REFERENCES edges.
   */
  async queryImpact(
    symbolName: string,
    projectId: number,
    depth: number,
  ): Promise<ImpactResult[]> {
    const d = Math.max(1, Math.min(depth, 6));
    const safeName = symbolName.replace(/'/g, "''");
    // WITH clause avoids a Kuzu 0.11 scoping bug with union-type recursive patterns + WHERE.
    // Target is bound first; then the recursive MATCH runs without a WHERE clause.
    const res = await this.conn.query(`
      MATCH (target:Symbol)
      WHERE target.name = '${safeName}' AND target.project_id = ${projectId}
      WITH target
      MATCH (caller:Symbol)-[:CALLS|REFERENCES*1..${d}]->(target)
      RETURN DISTINCT
        caller.id         AS id,
        caller.name       AS name,
        caller.kind       AS kind,
        caller.file_path  AS file_path,
        caller.start_line AS start_line
      ORDER BY name
      LIMIT 200
    `);
    const rows = await getRows(res);
    return rows.map(r => ({
      id: Number(r['id']),
      name: String(r['name']),
      kind: String(r['kind']),
      filePath: String(r['file_path']),
      startLine: Number(r['start_line']),
      depth: 0,  // hop count not available without path variable in Kuzu
    }));
  }

  /**
   * Find symbols involved in inheritance cycles (EXTENDS / IMPLEMENTS).
   * Returns symbols that appear in their own ancestor chain.
   */
  async queryCircularDeps(
    projectId: number,
    edgeKind: 'extends' | 'implements' | 'all' = 'all',
  ): Promise<CircularDepResult[]> {
    const rel = edgeKind === 'extends'
      ? 'EXTENDS'
      : edgeKind === 'implements'
        ? 'IMPLEMENTS'
        : 'EXTENDS|IMPLEMENTS';

    const res = await this.conn.query(`
      MATCH (s:Symbol)-[:${rel}*2..8]->(s)
      WHERE s.project_id = ${projectId}
      RETURN DISTINCT
        s.name      AS name,
        s.kind      AS kind,
        s.file_path AS file_path
      ORDER BY name
      LIMIT 100
    `);
    const rows = await getRows(res);
    return rows.map(r => ({
      name: String(r['name']),
      kind: String(r['kind']),
      filePath: String(r['file_path']),
    }));
  }

  /** Get basic graph statistics for a project */
  async getStats(projectId: number): Promise<{ nodes: number }> {
    const res = await this.conn.query(
      `MATCH (n:Symbol) WHERE n.project_id = ${projectId} RETURN count(*) AS cnt`,
    );
    const rows = await getRows(res);
    return { nodes: Number(rows[0]?.['cnt'] ?? 0) };
  }
}
