export class InputError extends Error {
  override readonly name = 'InputError';
}

export class StorageError extends Error {
  override readonly name = 'StorageError';
  readonly retryable: boolean;

  constructor(message: string, options: ErrorOptions & { retryable?: boolean } = {}) {
    super(message, options);
    this.retryable = options.retryable ?? false;
  }
}
