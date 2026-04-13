import { createHash } from 'crypto';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import type { Db } from '../storage/database.js';
import {
  upsertProject,
  touchProjectIndexed,
  upsertFile,
  getFile,
  deleteFileData,
  insertSymbol,
  insertDependency,
  insertRef,
  resolveProjectRefs,
  listProjectFiles,
} from '../storage/queries.js';
import { parseFile, detectLanguage } from './tree-sitter/parser.js';
import { extractFromJava } from './tree-sitter/java-extractor.js';

export interface IndexOptions {
  incremental?: boolean;
  verbose?: boolean;
}

export interface IndexResult {
  project: { id: number; name: string };
  indexed: number;
  skipped: number;
  errors: number;
  durationMs: number;
}

// ─── File collection ──────────────────────────────────────────────────────────

const SUPPORTED_EXTENSIONS = new Set(['.java']);

function collectFiles(dir: string): string[] {
  const result: string[] = [];
  // Directories skipped everywhere (tooling / hidden)
  const ALWAYS_SKIP = new Set(['node_modules', 'build', 'target', '.gradle']);
  // Directories skipped only at the project root (IDE / Gradle build outputs).
  // Nested dirs named 'out' are valid package segments in hexagonal-arch projects
  // (e.g. adapter/out/, port/out/) and must not be excluded.
  const ROOT_ONLY_SKIP = new Set(['out']);

  function walk(current: string): void {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    const isRoot = current === dir;
    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      if (ALWAYS_SKIP.has(entry)) continue;
      if (isRoot && ROOT_ONLY_SKIP.has(entry)) continue;
      const full = join(current, entry);
      let stat;
      try { stat = statSync(full); } catch { continue; }
      if (stat.isDirectory()) {
        walk(full);
      } else if (SUPPORTED_EXTENSIONS.has(full.slice(full.lastIndexOf('.')))) {
        result.push(full);
      }
    }
  }
  walk(dir);
  return result;
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

// ─── Single-file indexing ─────────────────────────────────────────────────────

function indexFile(db: Db, projectId: number, absolutePath: string, relativePath: string): void {
  const source = readFileSync(absolutePath, 'utf8');
  const hash = sha256(source);

  const existing = getFile(db, projectId, relativePath);
  const file = upsertFile(db, projectId, relativePath, hash);

  if (existing) {
    deleteFileData(db, file.id);
  }

  const lang = detectLanguage(absolutePath);
  if (!lang) return;

  const tree = parseFile(absolutePath, source);
  if (!tree) return;

  let extraction;
  if (lang === 'java') {
    extraction = extractFromJava(tree);
  } else {
    return;
  }

  // Insert symbols (track local id → DB id for parent references)
  const idMap = new Map<number, number>();

  for (const sym of extraction.symbols) {
    const localId = (sym as { _nodeId?: number })._nodeId;
    const parentDbId = sym.parent_id !== null && sym.parent_id !== undefined
      ? (idMap.get(sym.parent_id) ?? null)
      : null;

    const dbId = insertSymbol(db, {
      file_id: file.id,
      name: sym.name,
      kind: sym.kind,
      signature: sym.signature,
      parent_id: parentDbId,
      start_line: sym.start_line,
      end_line: sym.end_line,
      modifiers: sym.modifiers ?? undefined,
      annotations: sym.annotations ?? undefined,
    });

    if (localId !== undefined) idMap.set(localId, dbId);
  }

  for (const dep of extraction.dependencies) {
    insertDependency(db, file.id, dep.targetFqn, dep.kind);
  }

  // Refs: resolve callee names to symbol IDs where possible (best-effort, same-file only)
  // Build a name → DB id map for quick lookup
  const nameToDbId = new Map<string, number>();
  for (const sym of extraction.symbols) {
    const localId = (sym as { _nodeId?: number })._nodeId;
    if (localId !== undefined) {
      const dbId = idMap.get(localId);
      if (dbId !== undefined) nameToDbId.set(sym.name, dbId);
    }
  }

  for (const ref of extraction.refs) {
    const srcDbId = nameToDbId.get(ref.callerName) ?? null;
    const tgtDbId = nameToDbId.get(ref.calleeName) ?? null;
    // Store callee_name for unresolved refs so resolveProjectRefs can match cross-file
    const calleeName = tgtDbId === null ? ref.calleeName : null;
    insertRef(db, srcDbId, tgtDbId, ref.kind, calleeName);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function indexProject(
  db: Db,
  projectPath: string,
  projectName: string,
  options: IndexOptions = {}
): IndexResult {
  const start = Date.now();
  const { incremental = false, verbose = false } = options;

  const project = upsertProject(db, projectName, projectPath);
  const files = collectFiles(projectPath);

  let indexed = 0;
  let skipped = 0;
  let errors = 0;

  const indexOne = db.transaction((absPath: string) => {
    const rel = relative(projectPath, absPath);
    try {
      if (incremental) {
        const source = readFileSync(absPath, 'utf8');
        const hash = sha256(source);
        const existing = getFile(db, project.id, rel);
        if (existing?.content_hash === hash) {
          skipped++;
          return;
        }
      }
      indexFile(db, project.id, absPath, rel);
      indexed++;
      if (verbose) process.stderr.write(`  indexed: ${rel}\n`);
    } catch (err) {
      errors++;
      process.stderr.write(`  error: ${rel} — ${(err as Error).message}\n`);
    }
  });

  for (const f of files) {
    indexOne(f);
  }

  touchProjectIndexed(db, project.id);

  // Resolve cross-file references using the fully indexed project symbol table
  resolveProjectRefs(db, project.id);

  return {
    project: { id: project.id, name: project.name },
    indexed,
    skipped,
    errors,
    durationMs: Date.now() - start,
  };
}

export function reindexFile(db: Db, projectId: number, absolutePath: string, relativePath: string): void {
  const indexOne = db.transaction(() => {
    indexFile(db, projectId, absolutePath, relativePath);
  });
  indexOne();
}

export function getIndexedFileCount(db: Db, projectId: number): number {
  return listProjectFiles(db, projectId).length;
}
