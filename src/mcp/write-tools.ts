/**
 * Write Tools — Serena-compatible file editing capabilities
 *
 * Safety protocol per design spec:
 * 1. Pre-write: tree-sitter re-parse to verify symbol position matches DB
 * 2. Atomic write: write to .tmp, then rename()
 * 3. Post-write: reindexFile() to keep DB in sync
 */
import { readFileSync, writeFileSync, renameSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import type { Db } from '../storage/database.js';
import { listProjectFiles, getSymbolsByFile, getProjectById } from '../storage/queries.js';
import { parseFile } from '../indexer/tree-sitter/parser.js';
import { extractFromJava } from '../indexer/tree-sitter/java-extractor.js';
import { reindexFile } from '../indexer/indexer.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface VerifyResult {
  valid: boolean;
  reason?: 'not_found' | 'position_mismatch';
  symbol?: { startLine: number; endLine: number };
}

export interface WriteResult {
  success: boolean;
  error?: string;
  changedFiles?: string[];
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Resolve a file's DB record and project given its absolute path */
function resolveFile(db: Db, absolutePath: string): {
  fileId: number;
  projectId: number;
  relativePath: string;
} | null {
  // Walk all projects to find which one this file belongs to
  const projects = db.prepare('SELECT * FROM projects').all() as Array<{
    id: number;
    root_path: string;
  }>;
  for (const project of projects) {
    if (absolutePath.startsWith(project.root_path)) {
      const relPath = relative(project.root_path, absolutePath);
      const files = listProjectFiles(db, project.id);
      const fileRecord = files.find(f => f.relative_path === relPath);
      if (fileRecord) {
        return { fileId: fileRecord.id, projectId: project.id, relativePath: relPath };
      }
    }
  }
  return null;
}

/** Find a symbol's current position in a file via tree-sitter */
function findSymbolInFile(
  filePath: string,
  symbolName: string,
): { startLine: number; endLine: number } | null {
  let source: string;
  try {
    source = readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const tree = parseFile(filePath, source);
  if (!tree) return null;

  const extraction = extractFromJava(tree);
  const sym = extraction.symbols.find(s => s.name === symbolName);
  if (!sym) return null;
  return { startLine: sym.start_line, endLine: sym.end_line };
}

/** Read file as lines (1-based), modify, write back atomically */
function editLines(
  filePath: string,
  mutate: (lines: string[]) => string[],
): void {
  const original = readFileSync(filePath, 'utf8');
  const lines = original.split('\n');
  const updated = mutate(lines);
  atomicWriteFile(filePath, updated.join('\n'));
}

/** Get all project files for a given project ID */
function getProjectAbsolutePaths(db: Db, projectId: number): string[] {
  const project = getProjectById(db, projectId);
  if (!project) return [];
  const files = listProjectFiles(db, projectId);
  return files.map(f => join(project.root_path, f.relative_path));
}

// ─── B1: verifySymbolPosition ─────────────────────────────────────────────────

/**
 * Re-parse the file and verify that `symbolName` still occupies
 * [expectedStartLine, expectedEndLine] (1-based).
 * Returns { valid: true, symbol } if position matches, or { valid: false, reason }.
 */
export function verifySymbolPosition(
  filePath: string,
  symbolName: string,
  expectedStartLine: number,
  expectedEndLine: number,
): VerifyResult {
  const current = findSymbolInFile(filePath, symbolName);
  if (!current) {
    return { valid: false, reason: 'not_found' };
  }
  if (current.startLine !== expectedStartLine || current.endLine !== expectedEndLine) {
    return { valid: false, reason: 'position_mismatch', symbol: current };
  }
  return { valid: true, symbol: current };
}

// ─── B2: atomicWriteFile ──────────────────────────────────────────────────────

/**
 * Write `content` to `filePath` atomically:
 * 1. Write to filePath + '.tmp'
 * 2. Rename .tmp → filePath
 */
export function atomicWriteFile(filePath: string, content: string): void {
  const tmp = filePath + '.tmp';
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, filePath);
}

// ─── B3: replaceSymbolBody ────────────────────────────────────────────────────

/**
 * Replace the entire text of `symbolName` (from start_line to end_line inclusive)
 * with `newContent`. The new content completely replaces those lines.
 *
 * After replacement, re-indexes the file.
 */
export function replaceSymbolBody(
  db: Db,
  filePath: string,
  symbolName: string,
  newContent: string,
): WriteResult {
  const resolved = resolveFile(db, filePath);
  if (!resolved) {
    return { success: false, error: `File not indexed: ${filePath}` };
  }

  const symbols = getSymbolsByFile(db, resolved.fileId);
  const sym = symbols.find(s => s.name === symbolName);
  if (!sym) {
    return { success: false, error: `Symbol not found: ${symbolName}` };
  }

  // Pre-write: verify position
  const verify = verifySymbolPosition(filePath, symbolName, sym.start_line, sym.end_line);
  if (!verify.valid) {
    return {
      success: false,
      error: `Symbol position is stale (${verify.reason}). Re-index the file first.`,
    };
  }

  // Replace lines [start_line-1, end_line-1] (0-based) with new content
  editLines(filePath, lines => {
    const before = lines.slice(0, sym.start_line - 1);
    const after = lines.slice(sym.end_line);
    return [...before, ...newContent.split('\n'), ...after];
  });

  // Post-write: re-index
  const project = getProjectById(db, resolved.projectId)!;
  reindexFile(db, resolved.projectId, filePath, resolved.relativePath);

  return { success: true, changedFiles: [filePath] };
}

// ─── B4: insertAfterSymbol ────────────────────────────────────────────────────

/**
 * Insert `content` immediately after the last line of `symbolName`.
 * After insertion, re-indexes the file.
 */
export function insertAfterSymbol(
  db: Db,
  filePath: string,
  symbolName: string,
  content: string,
): WriteResult {
  const resolved = resolveFile(db, filePath);
  if (!resolved) {
    return { success: false, error: `File not indexed: ${filePath}` };
  }

  const symbols = getSymbolsByFile(db, resolved.fileId);
  const sym = symbols.find(s => s.name === symbolName);
  if (!sym) {
    return { success: false, error: `Symbol not found: ${symbolName}` };
  }

  const verify = verifySymbolPosition(filePath, symbolName, sym.start_line, sym.end_line);
  if (!verify.valid) {
    return {
      success: false,
      error: `Symbol position is stale (${verify.reason}). Re-index the file first.`,
    };
  }

  // Insert after end_line (0-based index: end_line-1, but splice inserts at that position)
  editLines(filePath, lines => {
    const insertAt = sym.end_line; // after end_line (1-based → 0-based insert after = end_line)
    return [...lines.slice(0, insertAt), ...content.split('\n'), ...lines.slice(insertAt)];
  });

  reindexFile(db, resolved.projectId, filePath, resolved.relativePath);
  return { success: true, changedFiles: [filePath] };
}

// ─── B5: insertBeforeSymbol ───────────────────────────────────────────────────

/**
 * Insert `content` immediately before the first line of `symbolName`.
 * After insertion, re-indexes the file.
 */
export function insertBeforeSymbol(
  db: Db,
  filePath: string,
  symbolName: string,
  content: string,
): WriteResult {
  const resolved = resolveFile(db, filePath);
  if (!resolved) {
    return { success: false, error: `File not indexed: ${filePath}` };
  }

  const symbols = getSymbolsByFile(db, resolved.fileId);
  const sym = symbols.find(s => s.name === symbolName);
  if (!sym) {
    return { success: false, error: `Symbol not found: ${symbolName}` };
  }

  const verify = verifySymbolPosition(filePath, symbolName, sym.start_line, sym.end_line);
  if (!verify.valid) {
    return {
      success: false,
      error: `Symbol position is stale (${verify.reason}). Re-index the file first.`,
    };
  }

  // Insert before start_line (1-based → 0-based = start_line - 1)
  editLines(filePath, lines => {
    const insertAt = sym.start_line - 1;
    return [...lines.slice(0, insertAt), ...content.split('\n'), ...lines.slice(insertAt)];
  });

  reindexFile(db, resolved.projectId, filePath, resolved.relativePath);
  return { success: true, changedFiles: [filePath] };
}

// ─── B6: renameSymbol ────────────────────────────────────────────────────────

/**
 * Text-based rename of `oldName` to `newName` across all files in the project.
 * Uses word-boundary regex to avoid renaming partial matches.
 *
 * Limitations: not type-aware; may miss dynamic dispatch or reflection usage.
 *
 * After rename, re-indexes all modified files.
 */
export function renameSymbol(
  db: Db,
  filePath: string,
  oldName: string,
  newName: string,
): WriteResult {
  const resolved = resolveFile(db, filePath);
  if (!resolved) {
    return { success: false, error: `File not indexed: ${filePath}` };
  }

  // Verify the symbol exists in the declaring file
  const symbols = getSymbolsByFile(db, resolved.fileId);
  const sym = symbols.find(s => s.name === oldName);
  if (!sym) {
    return { success: false, error: `Symbol not found: ${oldName}` };
  }

  const project = getProjectById(db, resolved.projectId)!;
  const allFiles = getProjectAbsolutePaths(db, resolved.projectId);
  const changedFiles: string[] = [];

  // Word-boundary regex to avoid partial matches (e.g., renaming "Foo" won't touch "FooBar")
  const pattern = new RegExp(`\\b${escapeRegex(oldName)}\\b`, 'g');

  for (const absPath of allFiles) {
    let source: string;
    try {
      source = readFileSync(absPath, 'utf8');
    } catch {
      continue;
    }
    if (!pattern.test(source)) continue;
    pattern.lastIndex = 0; // reset after test()

    const updated = source.replace(pattern, newName);
    atomicWriteFile(absPath, updated);
    changedFiles.push(absPath);

    const relPath = relative(project.root_path, absPath);
    reindexFile(db, resolved.projectId, absPath, relPath);
  }

  return { success: true, changedFiles };
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
