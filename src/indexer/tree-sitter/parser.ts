import Parser from 'tree-sitter';
// @ts-ignore — no official type declarations for tree-sitter-java
import Java from 'tree-sitter-java';

export type SupportedLanguage = 'java';

let javaParser: Parser | null = null;

export function getParser(language: SupportedLanguage): Parser {
  if (language === 'java') {
    if (!javaParser) {
      javaParser = new Parser();
      javaParser.setLanguage(Java);
    }
    return javaParser;
  }
  throw new Error(`Language not supported: ${language}`);
}

export function detectLanguage(filePath: string): SupportedLanguage | null {
  if (filePath.endsWith('.java')) return 'java';
  // Kotlin support is not yet enabled. To add it:
  //   1. Import tree-sitter-kotlin
  //   2. Add 'kotlin' to SupportedLanguage
  //   3. Initialize kotlin parser here
  //   4. Uncomment kotlin-extractor.ts usage in indexer.ts
  return null;
}

export function parseFile(filePath: string, source: string): Parser.Tree | null {
  const lang = detectLanguage(filePath);
  if (!lang) return null;
  return getParser(lang).parse(source);
}
