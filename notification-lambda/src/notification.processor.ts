import type { Logger } from '@aws-lambda-powertools/logger';
import type { AppConfig } from './config.js';
import type { NotificationRepository, NotificationRow } from './db/notification.repository.js';
import { EventErrorCode } from './enums/event-error-code.enum.js';
import { EventStatus } from './enums/event-status.enum.js';
import { NotificationStatus } from './enums/notification-status.enum.js';
import { InputError, StorageError } from './errors.js';
import { ErrorHelper } from './helpers/error.helper.js';
import { RetryHelper } from './helpers/retry.helper.js';
import type { EventData, EventDefinition } from './events/event-definition.interface.js';
import type { EventRegistry } from './events/event-registry.js';

const DB_MAX_RETRIES = 2;
const DB_RETRY_BASE_DELAY_MS = 50;
// Kept back from the Lambda timeout to log and return the report.
const DEADLINE_SAFETY_MS = 2_000;

export interface ProcessOptions {
  remainingTimeMs?: number;
}

export interface EventResult {
  index: number;
  type: string | null;
  eventId: string | null;
  status: EventStatus;
  notificationId?: number;
  error?: EventErrorCode;
  reasons?: string[];
}

export interface ProcessingReport {
  total: number;
  inserted: number;
  duplicates: number;
  invalid: number;
  failed: number;
  durationMs: number;
  results: EventResult[];
}

export interface NotificationProcessorParams {
  eventRegistry: EventRegistry;
  notificationRepository: NotificationRepository;
  config: AppConfig;
  logger: Logger;
}

interface ValidEvent {
  definition: EventDefinition;
  data: EventData;
}

interface InvalidEvent {
  error: EventErrorCode;
  reasons: string[];
  fields: string[];
}

export class NotificationProcessor {
  private readonly eventRegistry: EventRegistry;
  private readonly notificationRepository: NotificationRepository;
  private readonly config: AppConfig;
  private readonly logger: Logger;

  constructor(params: NotificationProcessorParams) {
    this.eventRegistry = params.eventRegistry;
    this.notificationRepository = params.notificationRepository;
    this.config = params.config;
    this.logger = params.logger;
  }

  async process(events: unknown, options: ProcessOptions = {}): Promise<ProcessingReport> {
    if (!Array.isArray(events)) {
      throw new InputError('Lambda event must be a JSON array of event objects');
    }

    const startedAt = Date.now();
    const { remainingTimeMs } = options;
    // No deadline outside Lambda (CLI, tests).
    const deadline =
      remainingTimeMs === undefined ? Infinity : startedAt + remainingTimeMs - DEADLINE_SAFETY_MS;
    const storedEventIds = new Set<string>();
    const results: EventResult[] = [];

    this.logger.info('Processing started', { events: events.length });

    // Sequential on purpose: notifications keep stream order and "first stored copy wins"
    // stays deterministic for duplicates.
    for (const [index, raw] of events.entries()) {
      // Stopping early returns a report for every event; being killed by the timeout returns
      // nothing, although some rows were already written.
      if (Date.now() >= deadline) {
        results.push(...this.skipRemaining(events, index));
        break;
      }

      results.push(await this.processEvent(raw, index, storedEventIds));
    }

    const count = (status: EventStatus) =>
      results.filter((result) => result.status === status).length;

    const summary = {
      total: events.length,
      inserted: count(EventStatus.Inserted),
      duplicates: count(EventStatus.Duplicate),
      invalid: count(EventStatus.Invalid),
      failed: count(EventStatus.Failed),
      durationMs: Date.now() - startedAt,
    };

    this.logger.info('Processing finished', summary);

    return { ...summary, results };
  }

  private async processEvent(
    raw: unknown,
    index: number,
    storedEventIds: Set<string>,
  ): Promise<EventResult> {
    const type = this.readType(raw);
    const eventId = this.readEventId(raw);
    const parsed = this.parseEvent(raw, type);

    if ('error' in parsed) {
      const { error, reasons, fields } = parsed;

      // Field names only: the reasons quote the submitted values (emails, names), which stay
      // out of the logs. The full reasons go back to the caller in the report.
      this.logger.warn('Invalid event skipped', { index, type, eventId, error, fields });

      return { index, type, eventId, status: EventStatus.Invalid, error, reasons };
    }

    if (eventId !== null && storedEventIds.has(eventId)) {
      this.logger.info('Duplicate event skipped', { index, type, eventId });

      return { index, type, eventId, status: EventStatus.Duplicate };
    }

    try {
      const { notificationId } = await this.insert(this.toRow(parsed), index);

      // Marked only after a successful insert, so an invalid or failed first copy
      // doesn't block a later valid copy of the same event.
      if (eventId !== null) storedEventIds.add(eventId);

      return { index, type, eventId, status: EventStatus.Inserted, notificationId };
    } catch (err) {
      const reason = ErrorHelper.getMessage(err);

      this.logger.error('Failed to store event', { index, type, eventId, error: reason });

      return {
        index,
        type,
        eventId,
        status: EventStatus.Failed,
        error: EventErrorCode.StorageFailed,
        reasons: [reason],
      };
    }
  }

  private parseEvent(raw: unknown, type: string | null): ValidEvent | InvalidEvent {
    if (!this.isObject(raw)) {
      return {
        error: EventErrorCode.InvalidEvent,
        reasons: ['event is not an object'],
        fields: [],
      };
    }

    if (type === null) {
      return {
        error: EventErrorCode.InvalidEvent,
        reasons: ['"type" is missing or not a string'],
        fields: ['type'],
      };
    }

    const definition = this.eventRegistry.get(type);

    if (!definition) {
      const supported = this.eventRegistry.types.join(', ');

      return {
        error: EventErrorCode.UnknownType,
        reasons: [`unknown event type "${type}" (supported: ${supported})`],
        fields: ['type'],
      };
    }

    const result = definition.schema.safeParse(raw);

    if (!result.success) {
      return {
        error: EventErrorCode.ValidationFailed,
        reasons: ErrorHelper.formatZodIssues(result.error),
        fields: ErrorHelper.zodIssueFields(result.error),
      };
    }

    return { definition, data: result.data };
  }

  private toRow({ definition, data }: ValidEvent): NotificationRow {
    return {
      NotificationTypeID: definition.notificationTypeId,
      NotificationData: data,
      Status: NotificationStatus.Inbox,
      Seen: 0,
      IsBookmarked: 0,
      CreatedByType: this.config.createdByType,
      CreatedByID: this.config.createdById,
    };
  }

  private insert(row: NotificationRow, index: number): Promise<{ notificationId: number }> {
    return RetryHelper.retry(() => this.notificationRepository.insertToMySQL(row), {
      retries: DB_MAX_RETRIES,
      baseDelayMs: DB_RETRY_BASE_DELAY_MS,
      // Only transient errors (lock timeout, lost connection) are worth retrying.
      shouldRetry: (error) => error instanceof StorageError && error.retryable,
      onRetry: (error, attempt) =>
        this.logger.warn('Retrying database insert', {
          index,
          attempt,
          error: ErrorHelper.getMessage(error),
        }),
    });
  }

  private skipRemaining(events: unknown[], fromIndex: number): EventResult[] {
    this.logger.warn('Lambda timeout is near, remaining events not processed', {
      skipped: events.length - fromIndex,
      fromIndex,
    });

    return events.slice(fromIndex).map((raw, offset) => ({
      index: fromIndex + offset,
      type: this.readType(raw),
      eventId: this.readEventId(raw),
      status: EventStatus.Failed,
      error: EventErrorCode.DeadlineExceeded,
      reasons: ['not processed: the Lambda was about to time out; send this event again'],
    }));
  }

  private isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  // Read from the raw event, so rejected events can still be reported with their type and id.
  private readType(raw: unknown): string | null {
    const type =
      this.isObject(raw) && typeof raw.type === 'string' ? raw.type.trim().toLowerCase() : '';

    return type || null;
  }

  private readEventId(raw: unknown): string | null {
    const id = this.isObject(raw) ? raw.event_id : undefined;

    if (typeof id === 'number') return String(id);
    if (typeof id === 'string' && id.trim()) return id.trim();

    return null;
  }
}
