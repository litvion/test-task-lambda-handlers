import type { Logger } from '@aws-lambda-powertools/logger';
import { setTimeout as sleep } from 'node:timers/promises';
import { StorageError } from '../errors.js';
import type { NotificationRepository, NotificationRow } from './notification.repository.js';

const COLUMNS = [
  'NotificationTypeID',
  'NotificationData',
  'Status',
  'Seen',
  'IsBookmarked',
  'CreatedByType',
  'CreatedByID',
] as const;

const INSERT_SQL =
  `INSERT INTO \`Notification\` (${COLUMNS.map((column) => `\`${column}\``).join(', ')}) ` +
  `VALUES (${COLUMNS.map(() => '?').join(', ')})`;

// Demo hooks: these email domains make the simulated database fail, to show retries
// and error reporting (see sample/edge-cases.json).
const ALWAYS_FAIL_DOMAIN = '@db-failure.test';
const FAIL_ONCE_DOMAIN = '@db-flaky.test';

export interface StoredNotification extends NotificationRow {
  NotificationID: number;
  Created: string;
}

export class SimulatedMySqlRepository implements NotificationRepository {
  readonly rows: StoredNotification[] = [];
  private nextId = 1;
  private readonly failedOnce = new Set<string>();

  constructor(
    private readonly logger: Logger,
    private readonly latencyMs = 0,
  ) {}

  // Parameterized INSERT, ready for mysql2's connection.execute(sql, params).
  static buildInsertStatement(row: NotificationRow): {
    sql: string;
    params: (string | number)[];
  } {
    const params = [
      row.NotificationTypeID,
      JSON.stringify(row.NotificationData),
      row.Status,
      row.Seen,
      row.IsBookmarked,
      row.CreatedByType,
      row.CreatedByID,
    ];

    return { sql: INSERT_SQL, params };
  }

  async insertToMySQL(event: NotificationRow): Promise<{ notificationId: number }> {
    const { sql } = SimulatedMySqlRepository.buildInsertStatement(event);

    if (this.latencyMs > 0) await sleep(this.latencyMs);

    this.simulateFailure(event);

    const notificationId = this.nextId++;

    this.rows.push({
      NotificationID: notificationId,
      Created: this.toMySqlDateTime(new Date()),
      ...event,
    });

    // Ids only: NotificationData holds personal data (email, name).
    this.logger.info('INSERT Notification', {
      notificationId,
      notificationTypeId: event.NotificationTypeID,
      eventId: event.NotificationData.event_id ?? null,
    });
    this.logger.debug('INSERT statement', { sql });

    return { notificationId };
  }

  private simulateFailure(event: NotificationRow): void {
    const email = String(event.NotificationData.email ?? '');
    const key = JSON.stringify(event.NotificationData);

    if (email.endsWith(ALWAYS_FAIL_DOMAIN)) {
      throw new StorageError('ER_LOCK_WAIT_TIMEOUT: Lock wait timeout exceeded (simulated)', {
        retryable: true,
      });
    }

    if (email.endsWith(FAIL_ONCE_DOMAIN) && !this.failedOnce.has(key)) {
      this.failedOnce.add(key);
      throw new StorageError('PROTOCOL_CONNECTION_LOST: Connection lost (simulated)', {
        retryable: true,
      });
    }
  }

  private toMySqlDateTime(date: Date): string {
    return date.toISOString().slice(0, 19).replace('T', ' ');
  }
}
