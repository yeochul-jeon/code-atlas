import { parseFile } from './parser.js';
import { extractFromJS } from './js-extractor.js';
import type { ExtractionResult } from './java-extractor.js';

interface ScriptBlock {
  body: string;
  lang: 'typescript' | 'javascript';
  /** 0-based row of the first line of the body inside the .vue source */
  lineOffset: number;
}

/**
 * Detect the script language from the <script> tag's attribute string.
 * Returns 'typescript' for lang="ts" or lang="typescript"; 'javascript' otherwise.
 */
function detectScriptLang(attrs: string): 'typescript' | 'javascript' {
  const m = attrs.match(/\blang\s*=\s*["']([^"']*)["']/i);
  if (!m) return 'javascript';
  const v = m[1].toLowerCase();
  return v === 'ts' || v === 'typescript' ? 'typescript' : 'javascript';
}

/**
 * Extract all <script> blocks from a Vue SFC source string.
 * Uses regex to find <script ...>body</script> pairs (handles both
 * <script lang="ts"> and <script setup lang="ts"> forms).
 *
 * Limitation: will mis-parse if script body contains the literal string
 * '</script>' — an extremely rare edge case in practice.
 */
function extractScriptBlocks(source: string): ScriptBlock[] {
  const blocks: ScriptBlock[] = [];
  // Match <script ...> ... </script> non-greedily.
  // Group 1: attribute string (may be undefined for bare <script>)
  // Group 2: body content
  const re = /<script(\b[^>]*)?>([^]*?)<\/script>/gi;
  let match: RegExpExecArray | null;

  while ((match = re.exec(source)) !== null) {
    const attrs = match[1] ?? '';
    const body = match[2];
    const lang = detectScriptLang(attrs);

    // Find where the body starts in the original source.
    // match[0] = openTag + body + '</script>', so openTag length = total - body - 9
    const openTagLen = match[0].length - body.length - '</script>'.length;
    const openTagEnd = match.index + openTagLen;
    const lineOffset = source.slice(0, openTagEnd).split('\n').length - 1;

    blocks.push({ body, lang, lineOffset });
  }
  return blocks;
}

/**
 * Extract symbols, dependencies, and refs from a Vue SFC (.vue) source string.
 *
 * Strategy (two-pass):
 *   1. Regex-extract every <script> / <script setup> block.
 *   2. Re-parse the extracted body with the existing JS/TS tree-sitter parser.
 *   3. Delegate to extractFromJS, then correct line numbers by adding the
 *      block's position (row) within the .vue file.
 */
export function extractFromVue(source: string): ExtractionResult {
  const merged: ExtractionResult = { symbols: [], dependencies: [], refs: [] };

  for (const block of extractScriptBlocks(source)) {
    if (!block.body.trim()) continue;

    const fakeFileName = block.lang === 'typescript' ? '_vue_script.ts' : '_vue_script.js';
    const innerTree = parseFile(fakeFileName, block.body);
    if (!innerTree) continue;

    try {
      const result = extractFromJS(innerTree, block.lang);

      // Adjust line numbers: inner parser starts at line 1, but the body
      // sits at lineOffset (0-based) inside the actual .vue file.
      for (const sym of result.symbols) {
        sym.start_line += block.lineOffset;
        sym.end_line   += block.lineOffset;
      }

      merged.symbols.push(...result.symbols);
      merged.dependencies.push(...result.dependencies);
      merged.refs.push(...result.refs);
    } finally {
      (innerTree as unknown as { delete?: () => void }).delete?.();
    }
  }

  return merged;
}
