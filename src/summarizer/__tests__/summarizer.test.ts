/**
 * Summarizer TDD Tests
 *
 * C1: Summarizer class (mocked Anthropic client)
 * C2: Cache logic — getOrGenerateSummary
 * C3: Integration with existing DB storage functions
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openDatabase } from '../../storage/database.js';
import { upsertProject, upsertFile, upsertSummary, getSummaryForFile } from '../../storage/queries.js';
import { Summarizer, getOrGenerateSummary } from '../summarizer.js';
import type { Db } from '../../storage/database.js';

// ─── Mock Anthropic client ────────────────────────────────────────────────────

function makeMockClient(responseText = 'This file handles cart operations.') {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: responseText }],
      }),
    },
  } as unknown as import('@anthropic-ai/sdk').default;
}

// ─── C1: Summarizer class ─────────────────────────────────────────────────────

describe('C1: Summarizer class', () => {
  it('generates a summary by calling the Anthropic API', async () => {
    const client = makeMockClient('Cart file summary here.');
    const summarizer = new Summarizer(client, { modelVersion: 'claude-haiku-4-5-20251001' });

    const result = await summarizer.generateFileSummary(
      'CartService.java',
      'public class CartService {}',
      [],
    );

    expect(result).toBe('Cart file summary here.');
    expect(client.messages.create).toHaveBeenCalledOnce();
  });

  it('passes file path and source code in the prompt', async () => {
    const client = makeMockClient();
    const summarizer = new Summarizer(client, { modelVersion: 'claude-haiku-4-5-20251001' });

    await summarizer.generateFileSummary(
      'src/main/Foo.java',
      'public class Foo { void bar() {} }',
      [],
    );

    const call = (client.messages.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const prompt = call.messages[0].content as string;
    expect(prompt).toContain('Foo.java');
    expect(prompt).toContain('public class Foo');
  });

  it('uses the configured model version', async () => {
    const client = makeMockClient();
    const summarizer = new Summarizer(client, { modelVersion: 'claude-sonnet-4-6' });

    await summarizer.generateFileSummary('File.java', 'class File {}', []);

    const call = (client.messages.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.model).toBe('claude-sonnet-4-6');
  });

  it('propagates API errors', async () => {
    const client = {
      messages: {
        create: vi.fn().mockRejectedValue(new Error('API rate limit exceeded')),
      },
    } as unknown as import('@anthropic-ai/sdk').default;
    const summarizer = new Summarizer(client, { modelVersion: 'claude-sonnet-4-6' });

    await expect(
      summarizer.generateFileSummary('File.java', 'class File {}', []),
    ).rejects.toThrow('API rate limit exceeded');
  });
});

// ─── C2: Cache logic ──────────────────────────────────────────────────────────

describe('C2: getOrGenerateSummary — cache logic', () => {
  let db: Db;
  let fileId: number;
  let client: ReturnType<typeof makeMockClient>;
  let summarizer: Summarizer;

  beforeEach(() => {
    db = openDatabase(':memory:');
    const project = upsertProject(db, 'test', '/tmp/test');
    const file = upsertFile(db, project.id, 'CartService.java', 'abc123');
    fileId = file.id;
    client = makeMockClient('Generated summary.');
    summarizer = new Summarizer(client, { modelVersion: 'claude-sonnet-4-6' });
  });
  afterEach(() => {
    db.close();
  });

  it('generates summary when cache is empty', async () => {
    const result = await getOrGenerateSummary(
      db, fileId, 'CartService.java', 'class CartService {}', [], summarizer, 'claude-sonnet-4-6',
    );
    expect(result).toBe('Generated summary.');
    expect(client.messages.create).toHaveBeenCalledOnce();
  });

  it('stores generated summary in DB for future calls', async () => {
    await getOrGenerateSummary(
      db, fileId, 'CartService.java', 'class CartService {}', [], summarizer, 'claude-sonnet-4-6',
    );
    const cached = getSummaryForFile(db, fileId);
    expect(cached).toBeDefined();
    expect(cached!.content).toBe('Generated summary.');
    expect(cached!.model_version).toBe('claude-sonnet-4-6');
  });

  it('returns cached summary on second call without calling API', async () => {
    // First call: generates
    await getOrGenerateSummary(
      db, fileId, 'CartService.java', 'class CartService {}', [], summarizer, 'claude-sonnet-4-6',
    );
    // Second call: should use cache
    const result = await getOrGenerateSummary(
      db, fileId, 'CartService.java', 'class CartService {}', [], summarizer, 'claude-sonnet-4-6',
    );
    expect(result).toBe('Generated summary.');
    // API called only once (for first generation)
    expect(client.messages.create).toHaveBeenCalledOnce();
  });

  it('regenerates summary when model_version differs', async () => {
    // Pre-existing cache with old model
    upsertSummary(db, fileId, null, 'Old summary.', 'claude-haiku-4-5-20251001');

    const newClient = makeMockClient('New summary with better model.');
    const newSummarizer = new Summarizer(newClient, { modelVersion: 'claude-sonnet-4-6' });

    const result = await getOrGenerateSummary(
      db, fileId, 'CartService.java', 'class CartService {}', [], newSummarizer, 'claude-sonnet-4-6',
    );

    expect(result).toBe('New summary with better model.');
    expect(newClient.messages.create).toHaveBeenCalledOnce();
  });

  it('returns cached summary when model_version matches', async () => {
    // Pre-existing cache with same model
    upsertSummary(db, fileId, null, 'Cached content.', 'claude-sonnet-4-6');

    const result = await getOrGenerateSummary(
      db, fileId, 'CartService.java', 'class CartService {}', [], summarizer, 'claude-sonnet-4-6',
    );

    expect(result).toBe('Cached content.');
    expect(client.messages.create).not.toHaveBeenCalled();
  });
});
