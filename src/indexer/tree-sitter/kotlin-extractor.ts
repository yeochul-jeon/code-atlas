/**
 * Kotlin extractor — NOT YET IMPLEMENTED
 *
 * To enable Kotlin support:
 *   1. Install tree-sitter-kotlin (already in package.json)
 *   2. Import and initialize kotlin parser in parser.ts
 *   3. Add 'kotlin' to SupportedLanguage type in parser.ts
 *   4. Add .kt / .kts detection in detectLanguage()
 *   5. Implement extractFromKotlin() below, mirroring java-extractor.ts
 *   6. Call extractFromKotlin() in indexer.ts where extractFromJava() is called
 */

import type Parser from 'tree-sitter';
import type { ExtractionResult } from './java-extractor.js';

export function extractFromKotlin(_tree: Parser.Tree): ExtractionResult {
  throw new Error(
    'Kotlin extraction is not yet implemented. ' +
    'See src/indexer/tree-sitter/kotlin-extractor.ts for instructions.'
  );
}
