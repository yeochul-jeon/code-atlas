import Parser from 'tree-sitter';
// @ts-ignore — no official type declarations for tree-sitter-java
import Java from 'tree-sitter-java';
// @ts-ignore — no official type declarations for tree-sitter-javascript
import JS from 'tree-sitter-javascript';
// @ts-ignore — no official type declarations for tree-sitter-typescript
import TS from 'tree-sitter-typescript';

export type SupportedLanguage = 'java' | 'javascript' | 'typescript' | 'tsx' | 'vue';

let javaParser: Parser | null = null;
let jsParser: Parser | null = null;
let tsParser: Parser | null = null;
let tsxParser: Parser | null = null;

export function getParser(language: SupportedLanguage): Parser {
  switch (language) {
    case 'java': {
      if (!javaParser) { javaParser = new Parser(); javaParser.setLanguage(Java); }
      return javaParser;
    }
    case 'javascript': {
      if (!jsParser) { jsParser = new Parser(); jsParser.setLanguage(JS); }
      return jsParser;
    }
    case 'typescript': {
      if (!tsParser) { tsParser = new Parser(); tsParser.setLanguage(TS.typescript); }
      return tsParser;
    }
    case 'tsx': {
      if (!tsxParser) { tsxParser = new Parser(); tsxParser.setLanguage(TS.tsx); }
      return tsxParser;
    }
    default:
      throw new Error(`Language not supported: ${language}`);
  }
}

export function detectLanguage(filePath: string): SupportedLanguage | null {
  const p = filePath.toLowerCase();
  if (p.endsWith('.java')) return 'java';
  if (p.endsWith('.vue')) return 'vue';
  // .d.ts — declaration-only files have no bodies; skip to avoid noisy ref-less symbols.
  if (p.endsWith('.d.ts')) return null;
  if (p.endsWith('.tsx')) return 'tsx';
  if (/\.(ts|mts|cts)$/.test(p)) return 'typescript';
  if (/\.(js|mjs|cjs|jsx)$/.test(p)) return 'javascript';
  return null;
}

// tree-sitter 0.21.x Node.js bindings reject strings ≥ 32,768 chars with "Invalid argument".
// For large files, use the streaming callback API instead.
const DIRECT_PARSE_LIMIT = 32767;
const CHUNK_SIZE = 4096;

export function parseFile(filePath: string, source: string): Parser.Tree | null {
  const lang = detectLanguage(filePath);
  if (!lang) return null;
  // Vue SFC outer structure is not parsed with tree-sitter; handled by vue-extractor instead.
  if (lang === 'vue') return null;

  // Strip UTF-8 BOM and normalize CRLF/CR → LF before feeding tree-sitter native binding.
  const normalized = source
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n');

  const p = getParser(lang);

  if (normalized.length <= DIRECT_PARSE_LIMIT) {
    return p.parse(normalized);
  }

  // Streaming callback: return fixed-size chunks so each call stays under the 32K limit.
  return p.parse((index: number) => {
    if (index >= normalized.length) return null;
    return normalized.slice(index, index + CHUNK_SIZE);
  });
}
