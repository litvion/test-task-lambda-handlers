import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it, mock } from 'node:test';
import { loadConfig } from '../src/config.js';
import type { NotificationRepository } from '../src/db/notification.repository.js';
import { SimulatedMySqlRepository } from '../src/db/simulated-mysql.repository.impl.js';
import { EventErrorCode } from '../src/enums/event-error-code.enum.js';
import { EventStatus } from '../src/enums/event-status.enum.js';
import { NotificationStatus } from '../src/enums/notification-status.enum.js';
import { NotificationType } from '../src/enums/notification-type.enum.js';
import { InputError, StorageError } from '../src/errors.js';
import { EventRegistry } from '../src/events/event-registry.js';
import { createLogger } from '../src/logger.js';
import { NotificationProcessor } from '../src/notification.processor.js';
import { RetryHelper } from '../src/helpers/retry.helper.js';

const logger = createLogger('SILENT');

async function sample(name: string): Promise<unknown[]> {
  return JSON.parse(await readFile(new URL(`../../sample/${name}`, import.meta.url), 'utf8'));
}

function setup(notificationRepository?: NotificationRepository) {
  const repository = new SimulatedMySqlRepository(logger);
  const processor = new NotificationProcessor({
    eventRegistry: new EventRegistry(),
    notificationRepository: notificationRepository ?? repository,
    config: loadConfig({}),
    logger,
  });

  return { repository, processor };
}

const userDeleted = { type: 'user_deleted', email: 'a@example.com', deleted: '2021-01-01' };

describe('NotificationProcessor with the assignment sample', () => {
  it('stores the valid events and reports the rest', async () => {
    const { processor } = setup();
    const report = await processor.process(await sample('events.json'));

    assert.deepEqual(
      [report.total, report.inserted, report.invalid, report.duplicates, report.failed],
      [7, 4, 2, 1, 0],
    );
    assert.deepEqual(
      report.results.map((r) => [r.index, r.status, r.error ?? null]),
      [
        [0, 'inserted', null],
        [1, 'invalid', 'validation_failed'],
        [2, 'inserted', null],
        [3, 'inserted', null],
        [4, 'invalid', 'unknown_type'],
        [5, 'inserted', null],
        [6, 'duplicate', null],
      ],
    );
    assert.deepEqual(report.results[1]!.reasons, [
      'email: "bob.smith(at)example.com" is not a valid email address',
    ]);
  });

  it('writes normalized Notification rows', async () => {
    const { repository, processor } = setup();

    await processor.process(await sample('events.json'));

    const { Created, ...first } = repository.rows[0]!;

    assert.match(Created, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.deepEqual(first, {
      NotificationID: 1,
      NotificationTypeID: NotificationType.UserRegistered,
      NotificationData: {
        name: 'Alice',
        email: 'alice@example.com',
        roles: ['admin', 'editor', 'manager'],
        joined: '2021-04-01T00:00:00.000Z',
      },
      Status: NotificationStatus.Inbox,
      Seen: 0,
      IsBookmarked: 0,
      CreatedByType: 0,
      CreatedByID: 0,
    });
    assert.deepEqual(
      repository.rows.map((row) => row.NotificationTypeID),
      [1, 2, 3, 1],
    );
    assert.deepEqual(repository.rows[3]!.NotificationData.roles, []);
  });
});

describe('NotificationProcessor edge cases', () => {
  it('never stops: every input gets a result, in order', async () => {
    const { processor } = setup();
    const input = await sample('edge-cases.json');
    const report = await processor.process(input);

    assert.deepEqual(
      report.results.map((r) => r.index),
      input.map((_, i) => i),
    );
    assert.equal(
      report.inserted + report.invalid + report.duplicates + report.failed,
      input.length,
    );
  });

  it('throws InputError when the Lambda event is not an array', async () => {
    const { processor } = setup();

    for (const event of [null, {}, 'events', { events: [] }]) {
      await assert.rejects(processor.process(event), InputError);
    }
  });

  it('rejects non-objects and events without a usable type', async () => {
    const { processor } = setup();
    const report = await processor.process([null, 'x', [1], {}, { type: 42 }, { type: '  ' }]);

    assert.ok(report.results.every((r) => r.error === EventErrorCode.InvalidEvent));
  });

  it('treats event_id 101 and "101" as the same event', async () => {
    const { processor } = setup();
    const report = await processor.process([
      { ...userDeleted, event_id: 101 },
      { ...userDeleted, event_id: '101' },
    ]);

    assert.deepEqual(
      report.results.map((r) => r.status),
      [EventStatus.Inserted, EventStatus.Duplicate],
    );
  });

  it('lets a valid copy through when the first copy of an event_id was invalid', async () => {
    const { processor } = setup();
    const report = await processor.process([
      { ...userDeleted, email: 'bad', event_id: 'x' },
      { ...userDeleted, event_id: 'x' },
    ]);

    assert.deepEqual(
      report.results.map((r) => r.status),
      [EventStatus.Invalid, EventStatus.Inserted],
    );
  });

  it('does not de-duplicate events without an event_id', async () => {
    const { processor } = setup();
    const report = await processor.process([userDeleted, userDeleted]);

    assert.equal(report.inserted, 2);
  });

  it('retries transient storage errors and reports permanent ones without stopping', async () => {
    let calls = 0;
    const repository: NotificationRepository = {
      async insertToMySQL(row) {
        calls++;
        const email = row.NotificationData.email;

        if (email === 'flaky@example.com' && calls === 1) {
          throw new StorageError('lost', { retryable: true });
        }
        if (email === 'broken@example.com') throw new StorageError('constraint violation');

        return { notificationId: calls };
      },
    };
    const { processor } = setup(repository);
    const report = await processor.process([
      { ...userDeleted, email: 'flaky@example.com' },
      { ...userDeleted, email: 'broken@example.com' },
      { ...userDeleted, email: 'fine@example.com' },
    ]);

    assert.deepEqual(
      report.results.map((r) => r.status),
      [EventStatus.Inserted, EventStatus.Failed, EventStatus.Inserted],
    );
    assert.equal(report.results[1]!.error, EventErrorCode.StorageFailed);
    assert.equal(calls, 4);
  });

  it('survives unexpected errors thrown by the repository', async () => {
    const { processor } = setup({
      insertToMySQL: () => Promise.reject(new TypeError('bug')),
    });
    const report = await processor.process([userDeleted]);

    assert.equal(report.failed, 1);
  });
});

describe('NotificationProcessor near the Lambda timeout', () => {
  it('reports every event as deadline_exceeded when no time is left', async () => {
    const { repository, processor } = setup();
    const report = await processor.process([userDeleted, userDeleted], { remainingTimeMs: 1_000 });

    assert.equal(repository.rows.length, 0);
    assert.deepEqual(
      report.results.map((r) => [r.index, r.status, r.error]),
      [
        [0, EventStatus.Failed, EventErrorCode.DeadlineExceeded],
        [1, EventStatus.Failed, EventErrorCode.DeadlineExceeded],
      ],
    );
  });

  it('stops before the timeout and still reports the events it did not reach', async () => {
    const slowRepository: NotificationRepository = {
      async insertToMySQL() {
        await new Promise((resolve) => setTimeout(resolve, 100));

        return { notificationId: 1 };
      },
    };
    const { processor } = setup(slowRepository);
    const events = Array.from({ length: 10 }, () => userDeleted);
    const startedAt = Date.now();
    const report = await processor.process(events, { remainingTimeMs: 2_250 });

    assert.ok(Date.now() - startedAt < 600);
    assert.ok(report.inserted > 0 && report.inserted < 10);
    assert.equal(report.inserted + report.failed, 10);
    assert.deepEqual(
      report.results.map((r) => r.index),
      events.map((_, i) => i),
    );
    assert.ok(
      report.results
        .filter((r) => r.status === EventStatus.Failed)
        .every((r) => r.error === EventErrorCode.DeadlineExceeded),
    );
  });
});

describe('Logging', () => {
  it('logs the invalid fields, not the submitted values', async () => {
    const warn = mock.method(logger, 'warn');
    const { processor } = setup();
    const report = await processor.process(await sample('events.json'));
    const logged = JSON.stringify(warn.mock.calls.map((call) => call.arguments));

    warn.mock.restore();
    assert.match(logged, /"fields":\["email"\]/);
    assert.doesNotMatch(logged, /bob\.smith/);
    assert.match(report.results[1]!.reasons![0]!, /bob\.smith\(at\)example\.com/);
  });
});

describe('SimulatedMySqlRepository', () => {
  it('builds a parameterized INSERT in column order', () => {
    const { sql, params } = SimulatedMySqlRepository.buildInsertStatement({
      NotificationTypeID: NotificationType.PasswordReset,
      NotificationData: { email: 'a@example.com' },
      Status: NotificationStatus.Inbox,
      Seen: 0,
      IsBookmarked: 0,
      CreatedByType: 0,
      CreatedByID: 0,
    });

    assert.match(
      sql,
      /^INSERT INTO `Notification` \(`NotificationTypeID`, .*\) VALUES \(\?(, \?){6}\)$/,
    );
    assert.deepEqual(params, [2, '{"email":"a@example.com"}', 0, 0, 0, 0, 0]);
  });

  it('does not log column values (PII) on insert', async () => {
    const info = mock.method(logger, 'info');
    const repository = new SimulatedMySqlRepository(logger);

    await repository.insertToMySQL({
      NotificationTypeID: NotificationType.UserRegistered,
      NotificationData: { event_id: 'e-1', name: 'Alice', email: 'alice@example.com' },
      Status: NotificationStatus.Inbox,
      Seen: 0,
      IsBookmarked: 0,
      CreatedByType: 0,
      CreatedByID: 0,
    });

    const logged = JSON.stringify(info.mock.calls.map((call) => call.arguments));

    info.mock.restore();
    assert.match(logged, /"eventId":"e-1"/);
    assert.doesNotMatch(logged, /alice@example\.com|Alice/);
  });
});

describe('RetryHelper', () => {
  it('gives up after the configured retries', async () => {
    let attempts = 0;
    const failing = async () => {
      attempts++;
      throw new StorageError('down', { retryable: true });
    };

    await assert.rejects(
      RetryHelper.retry(failing, { retries: 2, baseDelayMs: 0, shouldRetry: () => true }),
      /down/,
    );
    assert.equal(attempts, 3);
  });
});

describe('loadConfig', () => {
  it('applies defaults and parses provided values', () => {
    assert.deepEqual(loadConfig({}), {
      logLevel: 'INFO',
      createdByType: 0,
      createdById: 0,
      dbLatencyMs: 5,
    });
    assert.equal(loadConfig({ CREATED_BY_TYPE: '3', LOG_LEVEL: 'debug' }).createdByType, 3);
  });

  it('rejects invalid values with the variable name', () => {
    assert.throws(() => loadConfig({ CREATED_BY_TYPE: '256' }), /Invalid CREATED_BY_TYPE="256"/);
    assert.throws(() => loadConfig({ DB_LATENCY_MS: 'fast' }), /Invalid DB_LATENCY_MS="fast"/);
    assert.throws(() => loadConfig({ LOG_LEVEL: 'LOUD' }), /Invalid LOG_LEVEL="LOUD"/);
  });
});
