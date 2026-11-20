import Anthropic from '@anthropic-ai/sdk';
import { ProviderName } from '../enums/provider-name.enum.js';
import { ProviderError } from '../errors.js';
import { ErrorHelper } from '../helpers/error.helper.js';
import type { CompletionRequest, CompletionResponse, LlmAdapter } from './llm.adapter.js';

// Haiku 5.5 thinks adaptively and thinking tokens count toward max_tokens,
// so leave room on top of the answer budget.
const THINKING_HEADROOM_TOKENS = 2048;
const TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;

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

    if (message.stop_reason === 'refusal') {
      const category = message.stop_details?.category ?? 'unspecified';

      throw new ProviderError(`model declined the request (category: ${category})`);
    }

    if (message.stop_reason === 'max_tokens') {
      throw new ProviderError('reply cut off at max_tokens');
    }

    const text = message.content.map((block) => (block.type === 'text' ? block.text : '')).join('');

    if (!text) throw new ProviderError(`empty reply (stop_reason: ${message.stop_reason})`);

    return {
      text,
      usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens },
    };
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
