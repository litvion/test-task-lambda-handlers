import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { EmailProcessor, type ProcessOptions } from '../src/email.processor.js';
import { ItemErrorCode } from '../src/enums/item-error-code.enum.js';
import { ProviderName } from '../src/enums/provider-name.enum.js';
import { InputError, ProviderError } from '../src/errors.js';
import type { CompletionRequest, CompletionResponse, LlmAdapter } from '../src/llm/llm.adapter.js';
import { MockAdapter } from '../src/llm/mock.adapter.impl.js';
import { createLogger } from '../src/logger.js';
import { BatchPromptHelper } from '../src/helpers/batch-prompt.helper.js';

const logger = createLogger('SILENT');

async function sample(name: string): Promise<unknown[]> {
  return JSON.parse(await readFile(new URL(`../../sample/${name}`, import.meta.url), 'utf8'));
}

class FakeAdapter implements LlmAdapter {
  readonly name = 'fake';
  readonly calls: CompletionRequest[] = [];

  constructor(
    private readonly reply: (request: CompletionRequest) => string | Error = financeFor,
  ) {}

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    this.calls.push(request);
    const reply = this.reply(request);

    if (reply instanceof Error) throw reply;

    return { text: reply, usage: { inputTokens: 10, outputTokens: 5 } };
  }

  emailsSent(call: number): number {
    return BatchPromptHelper.decode(this.calls[call]!.prompt).length;
  }
}

function financeFor(request: CompletionRequest): string {
  const results = BatchPromptHelper.decode(request.prompt).map(({ k }) => ({
    k,
    topics: ['finance'],
  }));

  return JSON.stringify({ results });
}

function setup(llmAdapter: LlmAdapter = new FakeAdapter(), env: Record<string, string> = {}) {
  const config = loadConfig({ BATCH_SIZE: '3', MAX_CONCURRENCY: '2', ...env });
  const processor = new EmailProcessor({ llmAdapter, config, logger });

  return (emails: unknown[], mode = 'classify', options?: ProcessOptions) =>
    processor.process({ mode, emails }, options);
}

const emails = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    subject: `Subject ${i + 1}`,
    body: `Body ${i + 1}`,
  }));

describe('EmailProcessor with the sample files (mock adapter)', () => {
  const process = setup(new MockAdapter(), { CACHE_MAX_ENTRIES: '0' });

  it('classifies the assignment sample as in the PDF', async () => {
    const { results } = await process(await sample('emails.json'));

    assert.deepEqual(results.slice(0, 4), [
      { id: 1, topics: ['finance'] },
      { id: 2, topics: ['technical'] },
      { id: 3, topics: ['hr', 'marketing'] },
      { id: 4, error: 'empty_input' },
    ]);
    assert.deepEqual(results.at(-1), { id: 10, topics: ['other'] });
  });

  it('summarizes every valid email in at most 2 sentences', async () => {
    const { results } = await process(await sample('emails.json'), 'summarize');

    for (const result of results.filter((r) => 'summary' in r)) {
      const sentences = String(result.summary).match(/[.!?](\s|$)/g) ?? [];

      assert.ok(sentences.length <= 2, String(result.summary));
    }

    assert.deepEqual(results[3], { id: 4, error: 'empty_input' });
  });

  it('returns one result per edge-case item, in input order', async () => {
    const input = await sample('edge-cases.json');
    const { results, stats } = await process(input);

    const count = (error?: string) => results.filter((r) => r.error === error).length;

    assert.equal(results.length, input.length);
    assert.deepEqual(
      [count(undefined), count('empty_input'), count('invalid_item'), count('processing_failed')],
      [5, 2, 7, 1],
    );
    assert.deepEqual(results[13], { id: 14, error: 'processing_failed' });
    assert.equal(stats.deduplicated, 1);
  });
});

describe('EmailProcessor', () => {
  it('throws InputError for an unknown mode or a non-array "emails"', async () => {
    const processor = new EmailProcessor({
      llmAdapter: new FakeAdapter(),
      config: loadConfig({}),
      logger,
    });

    for (const event of [null, [], { mode: 'translate', emails: [] }, { mode: 'classify' }]) {
      await assert.rejects(processor.process(event), InputError);
    }
  });

  it('rejects invalid and empty items without calling the model', async () => {
    const llmAdapter = new FakeAdapter();
    const { results, stats } = await setup(llmAdapter)([
      { id: 1, subject: '', body: ' \n ' },
      { id: ' ', subject: 'x' },
      { id: 7, subject: 42 },
      'not an object',
    ]);

    assert.deepEqual(results, [
      { id: 1, error: 'empty_input' },
      { id: null, error: 'invalid_item' },
      { id: 7, error: 'invalid_item' },
      { id: null, error: 'invalid_item' },
    ]);
    assert.equal(stats.rejected, 4);
    assert.equal(llmAdapter.calls.length, 0);
  });

  it('accepts emails with only a subject or only a body', async () => {
    const { results } = await setup()([
      { id: 1, subject: 'Only a subject' },
      { id: 2, subject: null, body: 'Only a body' },
    ]);

    assert.deepEqual(results, [
      { id: 1, topics: ['finance'] },
      { id: 2, topics: ['finance'] },
    ]);
  });

  it('sends emails in batches and sizes max_tokens to the batch', async () => {
    const llmAdapter = new FakeAdapter();
    const { stats } = await setup(llmAdapter)(emails(7));

    assert.deepEqual(
      llmAdapter.calls.map((_, i) => llmAdapter.emailsSent(i)),
      [3, 3, 1],
    );
    assert.equal(llmAdapter.calls[0]!.maxTokens, 20 * 3 + 20);
    assert.deepEqual([stats.modelCalls, stats.inputTokens, stats.succeeded], [3, 30, 7]);
  });

  it('sends identical emails once and gives each its own copy of the result', async () => {
    const llmAdapter = new FakeAdapter();
    const same = { subject: 'Same', body: 'Same body' };
    const { results, stats } = await setup(llmAdapter)([
      { id: 1, ...same },
      { id: 2, ...same },
    ]);

    assert.equal(llmAdapter.emailsSent(0), 1);
    assert.equal(stats.deduplicated, 1);
    assert.deepEqual(results, [
      { id: 1, topics: ['finance'] },
      { id: 2, topics: ['finance'] },
    ]);
    assert.notEqual(results[0]!.topics, results[1]!.topics);
  });

  it('serves repeated emails from the cache on later invocations', async () => {
    const llmAdapter = new FakeAdapter();
    const process = setup(llmAdapter);

    await process(emails(2));
    const { results, stats } = await process(emails(2));

    assert.equal(llmAdapter.calls.length, 1);
    assert.equal(stats.cacheHits, 2);
    assert.deepEqual(results[0], { id: 1, topics: ['finance'] });
  });

  it('retries a failed batch email by email, so only the bad email fails', async () => {
    const llmAdapter = new FakeAdapter((request) =>
      BatchPromptHelper.decode(request.prompt).some((email) => email.b === 'Body 2')
        ? new Error('boom')
        : financeFor(request),
    );
    const { results, stats } = await setup(llmAdapter)(emails(3));

    assert.deepEqual(results, [
      { id: 1, topics: ['finance'] },
      { id: 2, error: 'processing_failed' },
      { id: 3, topics: ['finance'] },
    ]);
    assert.deepEqual([stats.retriedItems, stats.failed, llmAdapter.calls.length], [3, 1, 4]);
  });

  it('retries only the emails missing from an incomplete reply', async () => {
    const llmAdapter = new FakeAdapter((request) =>
      BatchPromptHelper.decode(request.prompt).length > 1
        ? JSON.stringify({ results: [{ k: 0, topics: ['hr'] }] })
        : financeFor(request),
    );
    const { results, stats } = await setup(llmAdapter)(emails(3));

    assert.deepEqual(results[0], { id: 1, topics: ['hr'] });
    assert.deepEqual([stats.retriedItems, stats.succeeded], [2, 3]);
  });

  it('reports an unparseable reply as processing_failed', async () => {
    const { results } = await setup(new FakeAdapter(() => 'I am not JSON'))(emails(1));

    assert.deepEqual(results, [{ id: 1, error: ItemErrorCode.ProcessingFailed }]);
  });

  it('stops calling the model after a fatal provider error', async () => {
    const llmAdapter = new FakeAdapter(
      () => new ProviderError('invalid x-api-key', { fatal: true }),
    );
    const { results, stats } = await setup(llmAdapter, { MAX_CONCURRENCY: '1' })(emails(7));

    assert.equal(llmAdapter.calls.length, 1);
    assert.deepEqual([stats.failed, stats.retriedItems], [7, 0]);
    assert.ok(results.every((r) => r.error === ItemErrorCode.ProcessingFailed));
  });

  it('keeps at most MAX_CONCURRENCY batches in flight', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const llmAdapter: LlmAdapter = {
      name: 'slow',
      async complete(request) {
        maxInFlight = Math.max(maxInFlight, ++inFlight);
        await new Promise((resolve) => setTimeout(resolve, 10));
        inFlight--;

        return { text: financeFor(request), usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };

    await setup(llmAdapter, { BATCH_SIZE: '1', MAX_CONCURRENCY: '3' })(emails(8));
    assert.equal(maxInFlight, 3);
  });

  it('stays within MAX_CONCURRENCY while retrying emails one by one', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const llmAdapter: LlmAdapter = {
      name: 'slow',
      async complete(request) {
        maxInFlight = Math.max(maxInFlight, ++inFlight);
        await new Promise((resolve) => setTimeout(resolve, 10));
        inFlight--;

        if (BatchPromptHelper.decode(request.prompt).length > 1) throw new Error('bad batch');

        return { text: financeFor(request), usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const { stats } = await setup(llmAdapter, { BATCH_SIZE: '3', MAX_CONCURRENCY: '2' })(emails(9));

    assert.deepEqual([stats.succeeded, stats.retriedItems], [9, 9]);
    assert.equal(maxInFlight, 2);
  });

  it('does not split a batch the service failed on (429, 5xx, network)', async () => {
    const llmAdapter = new FakeAdapter(
      () => new ProviderError('529 overloaded', { transient: true }),
    );
    const { stats } = await setup(llmAdapter)(emails(7));

    assert.equal(llmAdapter.calls.length, 3);
    assert.deepEqual([stats.failed, stats.retriedItems], [7, 0]);
  });

  it('starts no model call when the Lambda is about to time out', async () => {
    const llmAdapter = new FakeAdapter();
    const { results, stats } = await setup(llmAdapter)(emails(4), 'classify', {
      remainingTimeMs: 4_000,
    });

    assert.equal(llmAdapter.calls.length, 0);
    assert.equal(stats.failed, 4);
    assert.ok(results.every((r) => r.error === ItemErrorCode.ProcessingFailed));
  });

  it('aborts a call still running at the deadline and returns the results in time', async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const llmAdapter: LlmAdapter = {
      name: 'hanging',
      complete: (request) =>
        new Promise((_, reject) => {
          signals.push(request.signal);
          request.signal?.addEventListener('abort', () => reject(new ProviderError('aborted')));
        }),
    };
    // AbortSignal.timeout() does not keep Node alive; a real HTTP request would.
    const keepAlive = setTimeout(() => {}, 10_000);
    const startedAt = Date.now();
    const { stats } = await setup(llmAdapter)(emails(3), 'classify', { remainingTimeMs: 5_300 });

    assert.equal(signals.length, 1, 'no one-by-one retries after the deadline');
    assert.ok(signals[0]?.aborted);
    assert.equal(stats.failed, 3);
    clearTimeout(keepAlive);
    assert.ok(Date.now() - startedAt < 3_000);
  });

  it('passes no abort signal when there is no deadline (CLI)', async () => {
    const llmAdapter = new FakeAdapter();

    await setup(llmAdapter)(emails(1));
    assert.equal(llmAdapter.calls[0]!.signal, undefined);
  });

  it('caps long subjects and bodies before they reach the model', async () => {
    const llmAdapter = new FakeAdapter();

    await setup(llmAdapter, { MAX_BODY_CHARS: '100' })([
      { id: 1, subject: 'word '.repeat(500), body: 'word '.repeat(500) },
    ]);
    const [email] = BatchPromptHelper.decode(llmAdapter.calls[0]!.prompt);

    assert.ok(email!.s.length <= 201 && email!.b.length <= 101);
  });
});

describe('loadConfig', () => {
  it('applies defaults', () => {
    const config = loadConfig({});

    assert.equal(config.provider, ProviderName.Mock);
    assert.equal(config.anthropicModel, 'claude-haiku-5-5');
    assert.equal(config.batchSize, 10);
    assert.ok(config.topics.includes('other'));
  });

  it('normalizes topics and always allows "other"', () => {
    assert.deepEqual(loadConfig({ TOPICS: 'Billing, legal,billing,' }).topics, [
      'billing',
      'legal',
      'other',
    ]);
  });

  it('rejects invalid values with the variable name', () => {
    assert.throws(() => loadConfig({ BATCH_SIZE: 'ten' }), /Invalid BATCH_SIZE="ten"/);
    assert.throws(() => loadConfig({ PROVIDER: 'gpt-99' }), /Invalid PROVIDER="gpt-99"/);
    assert.throws(() => loadConfig({ LOG_LEVEL: 'LOUD' }), /Invalid LOG_LEVEL="LOUD"/);
  });

  it('requires an API key for the anthropic provider, without echoing it', () => {
    assert.throws(
      () => loadConfig({ PROVIDER: 'anthropic' }),
      /^Error: ANTHROPIC_API_KEY is required when PROVIDER=anthropic$/,
    );
    assert.equal(
      loadConfig({ PROVIDER: ' Anthropic ', ANTHROPIC_API_KEY: 'sk-test' }).provider,
      ProviderName.Anthropic,
    );
  });
});
