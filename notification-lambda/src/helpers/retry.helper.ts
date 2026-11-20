import { setTimeout as sleep } from 'node:timers/promises';

export interface RetryOptions {
  retries: number;
  baseDelayMs: number;
  shouldRetry: (error: unknown) => boolean;
  onRetry?: (error: unknown, attempt: number) => void;
}

export class RetryHelper {
  // Waits about baseDelayMs, then 2x, 4x... between attempts. The random half of each delay
  // (jitter) keeps concurrent Lambdas from retrying against the database in lockstep.
  static async retry<T>(operation: () => Promise<T>, options: RetryOptions): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await operation();
      } catch (error) {
        if (attempt >= options.retries || !options.shouldRetry(error)) throw error;

        const delayMs = options.baseDelayMs * 2 ** attempt;

        options.onRetry?.(error, attempt + 1);
        await sleep(delayMs / 2 + Math.random() * (delayMs / 2));
      }
    }
  }
}
