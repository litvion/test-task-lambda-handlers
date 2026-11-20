import type { Logger } from '@aws-lambda-powertools/logger';
import { createHash } from 'node:crypto';
import { LRUCache } from 'lru-cache';
import type { AppConfig } from './config.js';
import { ItemErrorCode } from './enums/item-error-code.enum.js';
import { InputError, ProviderError } from './errors.js';
import { BatchPromptHelper } from './helpers/batch-prompt.helper.js';
import { ConcurrencyHelper } from './helpers/concurrency.helper.js';
import { ErrorHelper } from './helpers/error.helper.js';
import { TextHelper } from './helpers/text.helper.js';
import type { LlmAdapter } from './llm/llm.adapter.js';
import { createMode } from './modes/mode.factory.js';
import type { Mode } from './modes/mode.interface.js';
import {
  classifierEventSchema,
  type EmailId,
  emailIdSchema,
  emailItemSchema,
} from './schemas/email.schema.js';

const REPLY_OVERHEAD_TOKENS = 20;
const MAX_SUBJECT_CHARS = 200;
// Kept back from the Lambda timeout to log and return the results.
const DEADLINE_SAFETY_MS = 3_000;
// A model call usually takes 1-3 s; with less time left it would only be aborted.
const MIN_CALL_TIME_MS = 2_000;

export interface ItemResult {
  id: EmailId | null;
  error?: ItemErrorCode;
  [field: string]: unknown;
}

export interface RunStats {
  total: number;
  succeeded: number;
  rejected: number;
  failed: number;
  cacheHits: number;
  deduplicated: number;
  modelCalls: number;
  retriedItems: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

export interface ProcessingOutput {
  results: ItemResult[];
  stats: RunStats;
}

export interface ProcessOptions {
  remainingTimeMs?: number;
}

export interface EmailProcessorParams {
  llmAdapter: LlmAdapter;
  config: AppConfig;
  logger: Logger;
}

interface Job {
  key: string;
  subject: string;
  body: string;
  targets: { index: number; id: EmailId }[];
}

interface Run {
  mode: Mode;
  results: ItemResult[];
  stats: RunStats;
  providerDown: boolean;
  deadline: number;
  deadlineLogged: boolean;
}

export class EmailProcessor {
  private readonly llmAdapter: LlmAdapter;
  private readonly config: AppConfig;
  private readonly logger: Logger;
  private readonly cache: LRUCache<string, object> | undefined;

  constructor(params: EmailProcessorParams) {
    this.llmAdapter = params.llmAdapter;
    this.config = params.config;
    this.logger = params.logger;
    this.cache =
      params.config.cacheMaxEntries > 0
        ? new LRUCache({ max: params.config.cacheMaxEntries })
        : undefined;
  }

  async process(event: unknown, options: ProcessOptions = {}): Promise<ProcessingOutput> {
    const parsed = classifierEventSchema.safeParse(event);

    if (!parsed.success) throw new InputError(parsed.error.issues[0]!.message);

    const { mode: modeName, emails } = parsed.data;
    const startedAt = Date.now();
    const { remainingTimeMs } = options;
    const run: Run = {
      mode: createMode(modeName, this.config),
      results: new Array<ItemResult>(emails.length),
      stats: this.emptyStats(emails.length),
      providerDown: false,
      // No deadline outside Lambda (CLI, tests).
      deadline:
        remainingTimeMs === undefined ? Infinity : startedAt + remainingTimeMs - DEADLINE_SAFETY_MS,
      deadlineLogged: false,
    };

    this.logger.info('Processing started', {
      mode: modeName,
      provider: this.llmAdapter.name,
      emails: emails.length,
    });

    const jobs = this.prepareJobs(emails, run);

    // One request per batch: the instructions are paid for once per batch, not once per email.
    await ConcurrencyHelper.run(
      ConcurrencyHelper.chunk(jobs, this.config.batchSize),
      this.config.maxConcurrency,
      (batch) => this.runBatch(batch, run),
    );

    run.stats.durationMs = Date.now() - startedAt;
    this.logger.info('Processing finished', { mode: modeName, ...run.stats });

    return { results: run.results, stats: run.stats };
  }

  // Invalid items and cache hits get their result here; identical emails are sent only once.
  private prepareJobs(items: readonly unknown[], run: Run): Job[] {
    const jobs = new Map<string, Job>();

    items.forEach((raw, index) => {
      const parsed = emailItemSchema.safeParse(raw);

      if (!parsed.success) {
        const reason = parsed.error.issues.map((issue) => issue.message).join('; ');

        return this.reject(run, index, this.readId(raw), ItemErrorCode.InvalidItem, reason);
      }

      const { id, subject, body } = parsed.data;

      if (!subject && !body) {
        return this.reject(run, index, id, ItemErrorCode.EmptyInput, 'subject and body are empty');
      }

      // Both fields are capped, so one oversized email can't inflate the cost of its batch.
      const truncatedSubject = TextHelper.truncate(subject, MAX_SUBJECT_CHARS);
      const truncatedBody = TextHelper.truncate(body, this.config.maxBodyChars);
      const key = this.cacheKey(run.mode, truncatedSubject, truncatedBody);
      const cached = this.cache?.get(key);

      if (cached) {
        run.results[index] = { id, ...structuredClone(cached) };
        run.stats.cacheHits++;
        run.stats.succeeded++;

        return;
      }

      const job = jobs.get(key);

      if (job) {
        job.targets.push({ index, id });
        run.stats.deduplicated++;
      } else {
        jobs.set(key, {
          key,
          subject: truncatedSubject,
          body: truncatedBody,
          targets: [{ index, id }],
        });
      }
    });

    return [...jobs.values()];
  }

  // Emails the reply doesn't cover (malformed entry, refusal, cut-off reply) are retried one by
  // one, so a single bad email can't fail its neighbours.
  private async runBatch(batch: Job[], run: Run): Promise<void> {
    const values = await this.callModel(batch, run);

    if (!values) {
      batch.forEach((job) => this.fail(run, job));

      return;
    }

    const missing = batch.filter((job, k) => {
      const value = values.get(k);

      if (value) this.settle(run, job, value);

      return !value;
    });

    if (missing.length === 0) return;

    if (batch.length === 1 || run.providerDown || this.isOutOfTime(run)) {
      missing.forEach((job) => this.fail(run, job));

      return;
    }

    run.stats.retriedItems += missing.length;
    this.logger.warn('Retrying emails one by one', {
      ids: missing.map((job) => job.targets[0]!.id),
    });

    // One at a time inside this lane, so retries never push calls in flight above MAX_CONCURRENCY.
    for (const job of missing) await this.runBatch([job], run);
  }

  // undefined means the call failed in a way that retrying emails one by one can't fix.
  private async callModel(batch: Job[], run: Run): Promise<Map<number, object> | undefined> {
    if (run.providerDown) return undefined;

    if (this.isOutOfTime(run)) {
      if (!run.deadlineLogged) {
        this.logger.warn('Lambda timeout is near, skipping remaining model calls');
        run.deadlineLogged = true;
      }

      return undefined;
    }

    const timeLeftMs = run.deadline - Date.now();

    run.stats.modelCalls++;

    try {
      const { text, usage } = await this.llmAdapter.complete({
        task: run.mode.name,
        system: run.mode.systemPrompt,
        prompt: BatchPromptHelper.encode(batch),
        // Output cap sized to the batch keeps the cost of a runaway reply bounded.
        maxTokens: run.mode.outputTokensPerEmail * batch.length + REPLY_OVERHEAD_TOKENS,
        signal: Number.isFinite(timeLeftMs) ? AbortSignal.timeout(timeLeftMs) : undefined,
      });

      run.stats.inputTokens += usage.inputTokens;
      run.stats.outputTokens += usage.outputTokens;

      return run.mode.parseReply(text, batch.length);
    } catch (err) {
      // A bad key or unknown model would fail every call, so stop calling the model.
      if (err instanceof ProviderError && err.fatal) {
        if (!run.providerDown) {
          this.logger.error('Model provider unusable, skipping remaining calls', {
            error: err.message,
          });
        }

        run.providerDown = true;

        return undefined;
      }

      this.logger.error('Model call failed', {
        ids: batch.map((job) => job.targets[0]!.id),
        error: ErrorHelper.getMessage(err),
      });

      // The service failed even after the SDK's retries; splitting the batch would only multiply
      // the load on it. After the deadline there is no time left for retries either.
      if ((err instanceof ProviderError && err.transient) || this.isOutOfTime(run)) {
        return undefined;
      }

      return new Map();
    }
  }

  private isOutOfTime(run: Run): boolean {
    return run.deadline - Date.now() < MIN_CALL_TIME_MS;
  }

  private settle(run: Run, job: Job, value: object): void {
    this.cache?.set(job.key, value);

    for (const { index, id } of job.targets) {
      run.results[index] = { id, ...structuredClone(value) };
      run.stats.succeeded++;
    }
  }

  private fail(run: Run, job: Job): void {
    for (const { index, id } of job.targets) {
      run.results[index] = { id, error: ItemErrorCode.ProcessingFailed };
      run.stats.failed++;
    }
  }

  private reject(
    run: Run,
    index: number,
    id: EmailId | null,
    error: ItemErrorCode,
    reason: string,
  ): void {
    this.logger.warn('Invalid item skipped', { index, id, error, reason });
    run.results[index] = { id, error };
    run.stats.rejected++;
  }

  private cacheKey(mode: Mode, subject: string, body: string): string {
    const parts = [this.llmAdapter.name, mode.systemPrompt, subject, body];

    return createHash('sha256').update(parts.join('\u0000')).digest('hex');
  }

  private readId(raw: unknown): EmailId | null {
    const id = typeof raw === 'object' && raw !== null ? (raw as { id?: unknown }).id : undefined;
    const parsed = emailIdSchema.safeParse(id);

    return parsed.success ? parsed.data : null;
  }

  private emptyStats(total: number): RunStats {
    return {
      total,
      succeeded: 0,
      rejected: 0,
      failed: 0,
      cacheHits: 0,
      deduplicated: 0,
      modelCalls: 0,
      retriedItems: 0,
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 0,
    };
  }
}
