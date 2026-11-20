import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { EventType } from '../src/enums/event-type.enum.js';
import type { NotificationType } from '../src/enums/notification-type.enum.js';
import { ErrorHelper } from '../src/helpers/error.helper.js';
import type { EventDefinition } from '../src/events/event-definition.interface.js';
import { EVENT_DEFINITIONS, EventRegistry } from '../src/events/event-registry.js';
import { passwordResetEvent } from '../src/events/password-reset.event.js';
import { userDeletedEvent } from '../src/events/user-deleted.event.js';
import { userRegisteredEvent } from '../src/events/user-registered.event.js';

describe('event schemas', () => {
  it('user_registered: normalizes every field and strips unknown ones', () => {
    const data = userRegisteredEvent.schema.parse({
      type: 'user_registered',
      name: '  Alice ',
      email: 'Alice@Example.com',
      roles: 'admin, editor ,  manager',
      joined: '2021-04-01',
      event_id: 7,
      extra: 'dropped',
    });

    assert.deepEqual(data, {
      event_id: '7',
      name: 'Alice',
      email: 'alice@example.com',
      roles: ['admin', 'editor', 'manager'],
      joined: '2021-04-01T00:00:00.000Z',
    });
  });

  it('reports every problem at once, with the field name', () => {
    const result = userRegisteredEvent.schema.safeParse({
      name: '',
      email: 'bob.smith(at)example.com',
      roles: ['viewer', 7],
      joined: 'yesterday',
    });

    assert.ok(!result.success);
    assert.deepEqual(ErrorHelper.formatZodIssues(result.error), [
      'name: is empty',
      'email: "bob.smith(at)example.com" is not a valid email address',
      'roles: contains a non-string value: 7',
      'joined: "yesterday" is not a valid date in a supported format',
    ]);
  });

  it('password_reset and user_deleted require an email and their date', () => {
    const reset = passwordResetEvent.schema.safeParse({ email: 'carol@example.com' });

    assert.ok(!reset.success);
    assert.deepEqual(ErrorHelper.formatZodIssues(reset.error), ['requested: is required']);
    assert.deepEqual(
      userDeletedEvent.schema.parse({ email: 'david@example.com', deleted: '2021-07-15T00:00:00' }),
      { email: 'david@example.com', deleted: '2021-07-15T00:00:00.000Z' },
    );
  });
});

describe('EventRegistry', () => {
  const registry = new EventRegistry();

  it('looks types up case- and whitespace-insensitively', () => {
    assert.equal(registry.get(' User_Registered ')?.type, EventType.UserRegistered);
    assert.equal(registry.get('unknown_type'), undefined);
  });

  it('rejects duplicate types', () => {
    assert.throws(
      () => new EventRegistry([userRegisteredEvent, userRegisteredEvent]),
      /Duplicate event type/,
    );
  });

  it('accepts a new event type without changes elsewhere', () => {
    const emailChanged: EventDefinition = {
      type: 'email_changed' as EventType,
      notificationTypeId: 4 as NotificationType,
      schema: z.object({ email: z.string(), changed: z.string() }),
    };

    assert.equal(new EventRegistry([emailChanged]).get('email_changed'), emailChanged);
  });

  it('matches the NotificationType rows in schema.sql', async () => {
    const sql = await readFile(new URL('../../schema.sql', import.meta.url), 'utf8');
    const rows = [...sql.matchAll(/\((\d+),\s*'([a-z_]+)'\)/g)].map((m) => [Number(m[1]), m[2]]);
    const registered = EVENT_DEFINITIONS.map((d) => [d.notificationTypeId, d.type]);

    assert.deepEqual(rows.sort(), registered.sort());
  });
});
