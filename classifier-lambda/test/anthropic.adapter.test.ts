import Anthropic from '@anthropic-ai/sdk';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { ModeName } from '../src/enums/mode-name.enum.js';
import { ProviderError } from '../src/errors.js';
import { AnthropicAdapter, type MessagesApi } from '../src/llm/anthropic.adapter.impl.js';
import type { CompletionRequest } from '../src/llm/llm.adapter.js';
import { createLlmAdapter } from '../src/llm/llm-adapter.factory.js';

type Params = Anthropic.MessageCreateParamsNonStreaming;

function message(overrides: Partial<Anthropic.Message> = {}): Anthropic.Message {
  return {
    content: [
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'text', text: '{"results":[]}' },
    ],
    stop_reason: 'end_turn',
    stop_details: null,
    usage: { input_tokens: 100, output_tokens: 40 },
    ...overrides,
  } as Anthropic.Message;
}

function fakeApi(reply: () => Anthropic.Message | Error = () => message()) {
  const calls: Params[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const messagesApi: MessagesApi = {
    async create(params, options) {
      calls.push(params);
      signals.push(options?.signal);
      const result = reply();

      if (result instanceof Error) throw result;

      return result;
    },
  };

  return { messagesApi, calls, signals };
}

function sdkError<T extends object>(errorClass: { prototype: T }, message = 'x'): T {
  return Object.assign(Object.create(errorClass.prototype) as T, { message });
}

const request: CompletionRequest = {
  task: ModeName.Classify,
  system: 'SYSTEM',
  prompt: '<emails>[]</emails>',
  maxTokens: 60,
};

const adapter = (messagesApi: MessagesApi) =>
  new AnthropicAdapter({ model: 'claude-haiku-5-5', messagesApi });

describe('AnthropicAdapter', () => {
  it('sends a small, low-effort request', async () => {
    const { messagesApi, calls } = fakeApi();

    await adapter(messagesApi).complete(request);

    assert.deepEqual(calls[0], {
      model: 'claude-haiku-5-5',
      max_tokens: 60 + 2048,
      system: 'SYSTEM',
      messages: [{ role: 'user', content: '<emails>[]</emails>' }],
      output_config: { effort: 'low' },
    });
  });

  it('passes the deadline signal to the SDK', async () => {
    const { messagesApi, signals } = fakeApi();
    const signal = AbortSignal.timeout(10_000);

    await adapter(messagesApi).complete({ ...request, signal });
    assert.equal(signals[0], signal);
  });

  it('returns the text blocks only, with token usage', async () => {
    const { messagesApi } = fakeApi();

    assert.deepEqual(await adapter(messagesApi).complete(request), {
      text: '{"results":[]}',
      usage: { inputTokens: 100, outputTokens: 40 },
    });
  });

  it('turns refusals, cut-off and empty replies into ProviderErrors', async () => {
    const cases: [Partial<Anthropic.Message>, RegExp][] = [
      [
        { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } } as never,
        /declined.*cyber/,
      ],
      [{ stop_reason: 'max_tokens' }, /cut off/],
      [{ content: [] }, /empty reply/],
    ];

    for (const [overrides, expected] of cases) {
      const { messagesApi } = fakeApi(() => message(overrides));

      await assert.rejects(adapter(messagesApi).complete(request), (err) => {
        assert.ok(err instanceof ProviderError);
        assert.ok(!err.fatal && expected.test(err.message));
        // Billed even though unusable, so the usage must reach the run stats.
        assert.deepEqual(err.usage, { inputTokens: 100, outputTokens: 40 });

        return true;
      });
    }
  });

  it('estimates the cost from the model list price', () => {
    const { messagesApi } = fakeApi();
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };

    assert.equal(adapter(messagesApi).estimateCostUsd(usage), 0.6);
    assert.equal(
      new AnthropicAdapter({ model: 'claude-unknown', messagesApi }).estimateCostUsd(usage),
      undefined,
    );
  });

  const errorCases: [string, Error, { fatal: boolean; transient: boolean }][] = [
    ['401', sdkError(Anthropic.AuthenticationError), { fatal: true, transient: false }],
    ['403', sdkError(Anthropic.PermissionDeniedError), { fatal: true, transient: false }],
    ['404', sdkError(Anthropic.NotFoundError), { fatal: true, transient: false }],
    [
      'missing credentials',
      new Error('Could not resolve authentication method'),
      { fatal: true, transient: false },
    ],
    ['400', sdkError(Anthropic.BadRequestError), { fatal: false, transient: false }],
    ['429', sdkError(Anthropic.RateLimitError), { fatal: false, transient: true }],
    ['500', sdkError(Anthropic.InternalServerError), { fatal: false, transient: true }],
    ['network', sdkError(Anthropic.APIConnectionError), { fatal: false, transient: true }],
  ];

  for (const [name, error, expected] of errorCases) {
    it(`maps ${name} errors to ProviderError ${JSON.stringify(expected)}`, async () => {
      const { messagesApi } = fakeApi(() => error);

      await assert.rejects(adapter(messagesApi).complete(request), (err) => {
        assert.ok(err instanceof ProviderError);
        assert.deepEqual({ fatal: err.fatal, transient: err.transient }, expected);
        assert.equal(err.cause, error);

        return true;
      });
    });
  }

  it('is created for PROVIDER=anthropic with the configured model', () => {
    const config = loadConfig({
      PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'sk-test',
      ANTHROPIC_MODEL: 'claude-sonnet-5-5',
    });

    assert.equal(createLlmAdapter(config).name, 'anthropic:claude-sonnet-5-5');
  });
});
