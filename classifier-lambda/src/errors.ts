import type { TokenUsage } from './llm/llm.adapter.js';

export class InputError extends Error {
  override readonly name = 'InputError';
}

// fatal: no later call can succeed (bad key, unknown model).
// transient: the service itself failed (429, 5xx, network), independent of the emails sent.
// usage: tokens billed for a reply that was still unusable (refusal, cut-off, empty).
export class ProviderError extends Error {
  override readonly name = 'ProviderError';
  readonly fatal: boolean;
  readonly transient: boolean;
  readonly usage: TokenUsage | undefined;

  constructor(
    message: string,
    options: ErrorOptions & { fatal?: boolean; transient?: boolean; usage?: TokenUsage } = {},
  ) {
    super(message, options);
    this.fatal = options.fatal ?? false;
    this.transient = options.transient ?? false;
    this.usage = options.usage;
  }
}
