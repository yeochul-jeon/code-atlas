import type { Db } from './database.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Project {
  id: number;
  name: string;
  root_path: string;
  last_indexed_at: string | null;
}

export interface FileRecord {
  id: number;
  project_id: number;
  relative_path: string;
  content_hash: string | null;
  last_indexed_at: string | null;
}

export interface Symbol {
  id: number;
  file_id: number;
  name: string;
  kind: string;
  signature: string | null;
  parent_id: number | null;
  start_line: number;
  end_line: number;
  modifiers: string | null;
  annotations: string | null;
}

export interface Dependency {
  id: number;
  source_file_id: number;
  target_fqn: string;
  kind: string;
}

export interface SymbolRef {
  id: number;
  source_symbol_id: number | null;
  target_symbol_id: number | null;
  kind: string;
}

export interface Summary {
  id: number;
  file_id: number | null;
  symbol_id: number | null;
  content: string;
  generated_at: string;
  model_version: string;
}

// ─── Projects ─────────────────────────────────────────────────────────────────

export function upsertProject(db: Db, name: string, rootPath: string): Project {
  db.prepare(`
    INSERT INTO projects (name, root_path) VALUES (?, ?)
    ON CONFLICT(root_path) DO UPDATE SET name = excluded.name
  `).run(name, rootPath);
  return db.prepare('SELECT * FROM projects WHERE root_path = ?').get(rootPath) as Project;
}

export function touchProjectIndexed(db: Db, projectId: number): void {
  db.prepare('UPDATE projects SET last_indexed_at = ? WHERE id = ?')
    .run(new Date().toISOString(), projectId);
}

export function listProjects(db: Db): Project[] {
  return db.prepare('SELECT * FROM projects ORDER BY name').all() as Project[];
}

export function getProjectById(db: Db, id: number): Project | undefined {
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project | undefined;
}

export function deleteProject(db: Db, projectId: number): void {
  db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
}

// ─── Files ────────────────────────────────────────────────────────────────────

export function upsertFile(
  db: Db,
  projectId: number,
  relativePath: string,
  contentHash: string
): FileRecord {
  db.prepare(`
    INSERT INTO files (project_id, relative_path, content_hash, last_indexed_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(project_id, relative_path) DO UPDATE SET
      content_hash    = excluded.content_hash,
      last_indexed_at = excluded.last_indexed_at
  `).run(projectId, relativePath, contentHash, new Date().toISOString());
  return db.prepare('SELECT * FROM files WHERE project_id = ? AND relative_path = ?')
    .get(projectId, relativePath) as FileRecord;
}

export function getFile(db: Db, projectId: number, relativePath: string): FileRecord | undefined {
  return db.prepare('SELECT * FROM files WHERE project_id = ? AND relative_path = ?')
    .get(projectId, relativePath) as FileRecord | undefined;
}

export function listProjectFiles(db: Db, projectId: number): FileRecord[] {
  return db.prepare('SELECT * FROM files WHERE project_id = ?').all(projectId) as FileRecord[];
}

export function deleteFileData(db: Db, fileId: number): void {
  db.prepare('DELETE FROM symbols WHERE file_id = ?').run(fileId);
  db.prepare('DELETE FROM dependencies WHERE source_file_id = ?').run(fileId);
}

// ─── Symbols ──────────────────────────────────────────────────────────────────

export interface InsertSymbolParams {
  file_id: number;
  name: string;
  kind: string;
  signature?: string | null;
  parent_id?: number | null;
  start_line: number;
  end_line: number;
  modifiers?: string[] | null;
  annotations?: string[] | null;
}

export function insertSymbol(db: Db, p: InsertSymbolParams): number {
  const result = db.prepare(`
    INSERT INTO symbols (file_id, name, kind, signature, parent_id, start_line, end_line, modifiers, annotations)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    p.file_id, p.name, p.kind, p.signature ?? null, p.parent_id ?? null,
    p.start_line, p.end_line,
    p.modifiers ? JSON.stringify(p.modifiers) : null,
    p.annotations ? JSON.stringify(p.annotations) : null
  );
  return result.lastInsertRowid as number;
}

export function getSymbolsByFile(db: Db, fileId: number): Symbol[] {
  return db.prepare('SELECT * FROM symbols WHERE file_id = ? ORDER BY start_line').all(fileId) as Symbol[];
}

export function getSymbolById(db: Db, symbolId: number): Symbol | undefined {
  return db.prepare('SELECT * FROM symbols WHERE id = ?').get(symbolId) as Symbol | undefined;
}

export function searchSymbolsFts(
  db: Db,
  query: string,
  kind?: string,
  projectId?: number,
  limit = 50
): Array<Symbol & { relative_path: string; project_name: string; root_path: string }> {
  type Row = Symbol & { relative_path: string; project_name: string; root_path: string };

  // Try FTS5 exact-prefix match first (fast, for symbol names starting with query)
  const ftsQuery = `"${query.replace(/"/g, '""')}"*`;
  const ftsParams: unknown[] = [ftsQuery];
  let ftsSql = `
    SELECT s.*, f.relative_path, p.name as project_name, p.root_path
    FROM symbols_fts sf
    JOIN symbols s ON sf.rowid = s.id
    JOIN files f ON s.file_id = f.id
    JOIN projects p ON f.project_id = p.id
    WHERE symbols_fts MATCH ?
  `;
  if (kind) { ftsSql += ' AND s.kind = ?'; ftsParams.push(kind); }
  if (projectId !== undefined) { ftsSql += ' AND p.id = ?'; ftsParams.push(projectId); }
  ftsSql += ' ORDER BY rank LIMIT ?';
  ftsParams.push(limit);

  const ftsResults = db.prepare(ftsSql).all(...ftsParams) as Row[];
  if (ftsResults.length > 0) return ftsResults;

  // Fallback: LIKE substring match for camelCase queries (e.g. "CartService")
  const likeParams: unknown[] = [`%${query}%`];
  let likeSql = `
    SELECT s.*, f.relative_path, p.name as project_name, p.root_path
    FROM symbols s
    JOIN files f ON s.file_id = f.id
    JOIN projects p ON f.project_id = p.id
    WHERE s.name LIKE ? ESCAPE '\\'
  `;
  if (kind) { likeSql += ' AND s.kind = ?'; likeParams.push(kind); }
  if (projectId !== undefined) { likeSql += ' AND p.id = ?'; likeParams.push(projectId); }
  likeSql += ' ORDER BY s.name LIMIT ?';
  likeParams.push(limit);

  return db.prepare(likeSql).all(...likeParams) as Row[];
}

// ─── Dependencies ─────────────────────────────────────────────────────────────

export function insertDependency(db: Db, sourceFileId: number, targetFqn: string, kind: string): void {
  db.prepare('INSERT INTO dependencies (source_file_id, target_fqn, kind) VALUES (?, ?, ?)')
    .run(sourceFileId, targetFqn, kind);
}

export function getDependenciesByFile(db: Db, fileId: number): Dependency[] {
  return db.prepare('SELECT * FROM dependencies WHERE source_file_id = ?').all(fileId) as Dependency[];
}

// ─── References ───────────────────────────────────────────────────────────────

export function insertRef(
  db: Db,
  sourceSymbolId: number | null,
  targetSymbolId: number | null,
  kind: string,
  calleeName?: string | null
): void {
  db.prepare('INSERT INTO refs (source_symbol_id, target_symbol_id, kind, callee_name) VALUES (?, ?, ?, ?)')
    .run(sourceSymbolId, targetSymbolId, kind, calleeName ?? null);
}

export function getRefsByTargetSymbol(db: Db, targetSymbolId: number): SymbolRef[] {
  return db.prepare('SELECT * FROM refs WHERE target_symbol_id = ?').all(targetSymbolId) as SymbolRef[];
}

/**
 * Resolves unlinked refs (target_symbol_id IS NULL) within a project by matching
 * callee_name against all symbol names in that project. Best-effort: simple name
 * match only (no FQN resolution). Updates refs in-place.
 */
export function resolveProjectRefs(db: Db, projectId: number): void {
  // Build a name → symbol id map for all symbols in this project
  const symbolRows = db.prepare(`
    SELECT s.id, s.name
    FROM symbols s
    JOIN files f ON s.file_id = f.id
    WHERE f.project_id = ?
  `).all(projectId) as { id: number; name: string }[];

  const nameToId = new Map<string, number>();
  for (const row of symbolRows) {
    // Last writer wins for duplicate names; good enough for best-effort resolution
    nameToId.set(row.name, row.id);
  }

  // Fetch all unresolved refs (callee_name set, target_symbol_id null)
  const unresolved = db.prepare(`
    SELECT r.id, r.callee_name
    FROM refs r
    JOIN symbols s ON r.source_symbol_id = s.id
    JOIN files f ON s.file_id = f.id
    WHERE f.project_id = ?
      AND r.target_symbol_id IS NULL
      AND r.callee_name IS NOT NULL
  `).all(projectId) as { id: number; callee_name: string }[];

  const update = db.prepare('UPDATE refs SET target_symbol_id = ? WHERE id = ?');
  const resolveAll = db.transaction(() => {
    for (const ref of unresolved) {
      const targetId = nameToId.get(ref.callee_name);
      if (targetId !== undefined) {
        update.run(targetId, ref.id);
      }
    }
  });
  resolveAll();
}

// ─── Summaries ────────────────────────────────────────────────────────────────

export function getSummaryForFile(db: Db, fileId: number): Summary | undefined {
  return db.prepare('SELECT * FROM summaries WHERE file_id = ? AND symbol_id IS NULL')
    .get(fileId) as Summary | undefined;
}

export function upsertSummary(
  db: Db,
  fileId: number,
  symbolId: number | null,
  content: string,
  modelVersion: string
): void {
  // SQLite treats NULL != NULL in UNIQUE constraints, so we use DELETE + INSERT
  // to reliably replace file-level summaries (symbol_id IS NULL).
  db.prepare(
    'DELETE FROM summaries WHERE file_id = ? AND symbol_id IS ?'
  ).run(fileId, symbolId);
  db.prepare(`
    INSERT INTO summaries (file_id, symbol_id, content, generated_at, model_version)
    VALUES (?, ?, ?, ?, ?)
  `).run(fileId, symbolId, content, new Date().toISOString(), modelVersion);
}

// ─── Dead Code Detection ──────────────────────────────────────────────────────

// Annotations that mark a symbol as "live" (cannot be dead code).
// Includes standard Spring stereotypes and common hexagonal-arch custom annotations
// that are meta-annotated with @Component (@WebAdapter, @UseCase, @PersistenceAdapter, @ApiAdapter).
const EXCLUDED_ANNOTATIONS = new Set([
  // Spring stereotypes
  '@RestController', '@Controller',
  '@Service',
  '@Component',
  '@Repository',
  '@Bean',
  '@Configuration',
  '@Override',
  // Common hexagonal-architecture custom stereotypes (meta-annotated with @Component)
  '@WebAdapter',
  '@UseCase',
  '@PersistenceAdapter',
  '@ApiAdapter',
]);

// Kinds that are always excluded from dead code analysis
const EXCLUDED_KINDS = new Set(['constructor', 'annotation_type', 'enum']);

export interface DeadSymbol {
  id: number;
  name: string;
  kind: string;
  signature: string | null;
  start_line: number;
  end_line: number;
  modifiers: string | null;
  annotations: string | null;
  relative_path: string;
  project_name: string;
  root_path: string;
}

export function findDeadCode(
  db: Db,
  projectId: number,
  kind?: string
): DeadSymbol[] {
  type Row = DeadSymbol;

  let sql = `
    SELECT s.*, f.relative_path, p.name AS project_name, p.root_path
    FROM symbols s
    JOIN files f ON s.file_id = f.id
    JOIN projects p ON f.project_id = p.id
    WHERE p.id = ?
      AND NOT EXISTS (
        SELECT 1 FROM refs r WHERE r.target_symbol_id = s.id
      )
  `;
  const params: unknown[] = [projectId];

  if (kind) {
    sql += ' AND s.kind = ?';
    params.push(kind);
  }

  const rows = db.prepare(sql).all(...params) as Row[];

  return rows.filter(row => {
    // Exclude always-excluded kinds
    if (EXCLUDED_KINDS.has(row.kind)) return false;

    // Exclude main() entry point
    if (row.name === 'main' && row.kind === 'method') return false;

    // Exclude public static final fields (constants)
    if (row.kind === 'field') {
      const mods: string[] = row.modifiers ? JSON.parse(row.modifiers) : [];
      if (mods.includes('public') && mods.includes('static') && mods.includes('final')) return false;
    }

    // Exclude symbols with framework annotations
    const anns: string[] = row.annotations ? JSON.parse(row.annotations) : [];
    if (anns.some(a => EXCLUDED_ANNOTATIONS.has(a))) return false;

    return true;
  });
}

// ─── Stats ────────────────────────────────────────────────────────────────────

export function getStats(db: Db): {
  projects: number; files: number; symbols: number; dependencies: number;
} {
  const r = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM projects)     AS projects,
      (SELECT COUNT(*) FROM files)        AS files,
      (SELECT COUNT(*) FROM symbols)      AS symbols,
      (SELECT COUNT(*) FROM dependencies) AS dependencies
  `).get() as { projects: number; files: number; symbols: number; dependencies: number };
  return r;
}
