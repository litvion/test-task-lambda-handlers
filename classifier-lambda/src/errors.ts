export class InputError extends Error {
  override readonly name = 'InputError';
}

// fatal: no later call can succeed (bad key, unknown model).
// transient: the service itself failed (429, 5xx, network), independent of the emails sent.
export class ProviderError extends Error {
  override readonly name = 'ProviderError';
  readonly fatal: boolean;
  readonly transient: boolean;

  constructor(
    message: string,
    options: ErrorOptions & { fatal?: boolean; transient?: boolean } = {},
  ) {
    super(message, options);
    this.fatal = options.fatal ?? false;
    this.transient = options.transient ?? false;
  }
}
