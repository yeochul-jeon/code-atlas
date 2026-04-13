/**
 * Summarizer — Lazy AI summary generation with DB caching
 *
 * Usage:
 *   const summarizer = new Summarizer(anthropicClient, { modelVersion: 'claude-sonnet-4-6' });
 *   const text = await getOrGenerateSummary(db, fileId, filePath, source, symbols, summarizer, modelVersion);
 *
 * On first call: generates via Anthropic API and stores in `summaries` table.
 * On subsequent calls with matching model_version: returns cached DB content.
 * On model_version change: regenerates.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { Db } from '../storage/database.js';
import { getSummaryForFile, upsertSummary } from '../storage/queries.js';
import type { Symbol } from '../storage/queries.js';

// ─── Config ───────────────────────────────────────────────────────────────────

export interface SummarizerConfig {
  modelVersion: string;
}

// ─── Summarizer class ─────────────────────────────────────────────────────────

export class Summarizer {
  constructor(
    private readonly client: Anthropic,
    private readonly config: SummarizerConfig,
  ) {}

  async generateFileSummary(
    filePath: string,
    sourceCode: string,
    symbols: Pick<Symbol, 'name' | 'kind'>[],
  ): Promise<string> {
    const prompt = buildPrompt(filePath, sourceCode, symbols);
    const response = await this.client.messages.create({
      model: this.config.modelVersion,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }) as Anthropic.Message;
    return extractText(response);
  }
}

// ─── Cache-aware entry point ──────────────────────────────────────────────────

/**
 * Return the cached summary for `fileId` if it exists and was generated with
 * `modelVersion`. Otherwise call `summarizer.generateFileSummary()`, store the
 * result, and return it.
 */
export async function getOrGenerateSummary(
  db: Db,
  fileId: number,
  filePath: string,
  sourceCode: string,
  symbols: Pick<Symbol, 'name' | 'kind'>[],
  summarizer: Summarizer,
  modelVersion: string,
): Promise<string> {
  const cached = getSummaryForFile(db, fileId);
  if (cached && cached.model_version === modelVersion) {
    return cached.content;
  }

  const content = await summarizer.generateFileSummary(filePath, sourceCode, symbols);
  upsertSummary(db, fileId, null, content, modelVersion);
  return content;
}

// ─── Prompt builder ───────────────────────────────────────────────────────────

function buildPrompt(
  filePath: string,
  sourceCode: string,
  symbols: Pick<Symbol, 'name' | 'kind'>[],
): string {
  const symbolSummary = symbols.length > 0
    ? symbols.map(s => `- ${s.kind}: ${s.name}`).join('\n')
    : '(no symbols extracted)';

  // Limit source to first 4000 chars to stay within reasonable token budget
  const truncatedSource = sourceCode.length > 4000
    ? sourceCode.slice(0, 4000) + '\n... (truncated)'
    : sourceCode;

  return `You are a senior software engineer. Provide a concise 2-4 sentence summary of the following Java/Kotlin source file.
Focus on: what the file does, its primary responsibility, and key design patterns used.
Do NOT list every method — give a high-level overview.

File: ${filePath}

Symbols:
${symbolSummary}

Source:
\`\`\`java
${truncatedSource}
\`\`\`

Summary:`;
}

function extractText(response: Anthropic.Message): string {
  const block = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
  if (!block) {
    throw new Error('No text block in Anthropic response');
  }
  return block.text.trim();
}
