import Anthropic from '@anthropic-ai/sdk';
import { ProviderName } from '../enums/provider-name.enum.js';
import { ProviderError } from '../errors.js';
import { ErrorHelper } from '../helpers/error.helper.js';
import type {
  CompletionRequest,
  CompletionResponse,
  LlmAdapter,
  TokenUsage,
} from './llm.adapter.js';

// Haiku 5.5 thinks adaptively and thinking tokens count toward max_tokens,
// so leave room on top of the answer budget.
const THINKING_HEADROOM_TOKENS = 2048;
const TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;
const TOKENS_PER_MILLION = 1_000_000;

// USD per million tokens, Anthropic API list prices (Haiku: prompts up to 100K tokens, which a
// batch of 10 truncated emails never reaches). Update when prices change or a model is added.
const PRICES_USD_PER_MTOK: Record<string, { input: number; output: number }> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-opus-5-5': { input: 4, output: 20 },
};

export interface MessagesApi {
  create(
    params: Anthropic.MessageCreateParamsNonStreaming,
    options?: { signal?: AbortSignal },
  ): Promise<Anthropic.Message>;
}

export interface AnthropicAdapterParams {
  model: string;
  apiKey?: string;
  messagesApi?: MessagesApi;
}

export class AnthropicAdapter implements LlmAdapter {
  readonly name: string;
  private readonly model: string;
  private readonly messagesApi: MessagesApi;

  constructor(params: AnthropicAdapterParams) {
    this.model = params.model;
    this.name = `${ProviderName.Anthropic}:${params.model}`;
    this.messagesApi =
      params.messagesApi ??
      new Anthropic({ apiKey: params.apiKey, timeout: TIMEOUT_MS, maxRetries: MAX_RETRIES })
        .messages;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    let message: Anthropic.Message;

    try {
      message = await this.messagesApi.create(
        {
          model: this.model,
          max_tokens: request.maxTokens + THINKING_HEADROOM_TOKENS,
          system: request.system,
          messages: [{ role: 'user', content: request.prompt }],
          // Topic labels and short summaries need little reasoning; Haiku defaults to medium.
          output_config: { effort: 'low' },
        },
        // Aborts the request, including the SDK's own retries, when the Lambda runs out of time.
        { signal: request.signal },
      );
    } catch (err) {
      throw this.toProviderError(err);
    }

    const usage = {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
    };

    // These replies are billed like any other, so their usage travels with the error.
    if (message.stop_reason === 'refusal') {
      const category = message.stop_details?.category ?? 'unspecified';

      throw new ProviderError(`model declined the request (category: ${category})`, { usage });
    }

    if (message.stop_reason === 'max_tokens') {
      throw new ProviderError('reply cut off at max_tokens', { usage });
    }

    const text = message.content.map((block) => (block.type === 'text' ? block.text : '')).join('');

    if (!text) {
      throw new ProviderError(`empty reply (stop_reason: ${message.stop_reason})`, { usage });
    }

    return { text, usage };
  }

  estimateCostUsd(usage: TokenUsage): number | undefined {
    const price = PRICES_USD_PER_MTOK[this.model];

    if (!price) return undefined;

    return (
      (usage.inputTokens * price.input + usage.outputTokens * price.output) / TOKENS_PER_MILLION
    );
  }

  private toProviderError(err: unknown): ProviderError {
    const isConfigError =
      err instanceof Anthropic.AuthenticationError ||
      err instanceof Anthropic.PermissionDeniedError ||
      err instanceof Anthropic.NotFoundError;

    // Bad key, no access or unknown model: retrying can't help.
    if (isConfigError) {
      return new ProviderError(`${err.message} (check ANTHROPIC_API_KEY and ANTHROPIC_MODEL)`, {
        fatal: true,
        cause: err,
      });
    }

    const isServiceError =
      err instanceof Anthropic.RateLimitError ||
      err instanceof Anthropic.InternalServerError ||
      err instanceof Anthropic.APIConnectionError;

    // Still failing after the SDK's retries with backoff (429, 5xx incl. overloaded, timeouts).
    if (isServiceError) return new ProviderError(err.message, { transient: true, cause: err });

    if (err instanceof Anthropic.APIError) return new ProviderError(err.message, { cause: err });

    // Thrown before a request was sent (e.g. missing credentials), so every call would hit it.
    return new ProviderError(`Anthropic client error: ${ErrorHelper.getMessage(err)}`, {
      fatal: true,
      cause: err,
    });
  }
}
