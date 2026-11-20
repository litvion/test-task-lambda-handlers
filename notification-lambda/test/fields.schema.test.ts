import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { z } from 'zod';
import {
  dateSchema,
  emailSchema,
  eventIdSchema,
  rolesSchema,
} from '../src/schemas/fields.schema.js';

function parsed<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);

  assert.ok(result.success, result.error?.issues[0]?.message ?? '');

  return result.data;
}

function failure(schema: z.ZodType, input: unknown): string {
  const result = schema.safeParse(input);

  assert.equal(result.success, false, 'expected a validation failure');

  return result.error?.issues[0]?.message ?? '';
}

describe('dateSchema', () => {
  const valid: [string, string][] = [
    ['2021-04-01', '2021-04-01T00:00:00.000Z'],
    ['April 5th, 2021 13:45 PST', '2021-04-05T21:45:00.000Z'],
    ['2021/06/01 10:23+02:00', '2021-06-01T08:23:00.000Z'],
    ['2021-07-15T00:00:00', '2021-07-15T00:00:00.000Z'],
    ['2021-07-15T10:00:00Z', '2021-07-15T10:00:00.000Z'],
    ['2021-07-15T10:00:00+05:30', '2021-07-15T04:30:00.000Z'],
    ['2021-07-15T10:00:00.123-03:00', '2021-07-15T13:00:00.123Z'],
    ['2021-01-01T01:00:00+03:00', '2020-12-31T22:00:00.000Z'],
    ['April 5, 2021 13:45 cest', '2021-04-05T11:45:00.000Z'],
    ['Apr 5th, 2021 08:00', '2021-04-05T08:00:00.000Z'],
    ['  2021-04-01  ', '2021-04-01T00:00:00.000Z'],
    ['2024-02-29', '2024-02-29T00:00:00.000Z'],
    ['2021-7-5', '2021-07-05T00:00:00.000Z'],
  ];

  for (const [input, expected] of valid) {
    it(`"${input}" -> ${expected}`, () => assert.equal(parsed(dateSchema, input), expected));
  }

  const UNSUPPORTED = /not a valid date in a supported format/;
  const invalid: [unknown, RegExp][] = [
    ['yesterday', UNSUPPORTED],
    ['01/02/2021', UNSUPPORTED],
    ['2021-02-30', UNSUPPORTED],
    ['2023-02-29', UNSUPPORTED],
    ['2021-13-01', UNSUPPORTED],
    ['2021-04-01T24:00:00', UNSUPPORTED],
    ['2021-04-01 13:45 PM', UNSUPPORTED],
    ['Monday, April 5, 2021 1:45 PM EDT', UNSUPPORTED],
    ['April 5, 2021 10:00 XYZ', /unknown time zone "XYZ"/],
    ['', /empty/],
    [1626307200, /must be a date string/],
    [null, /is required/],
    [undefined, /is required/],
  ];

  for (const [input, expected] of invalid) {
    it(`rejects ${JSON.stringify(input)}`, () =>
      assert.match(failure(dateSchema, input), expected));
  }
});

describe('emailSchema', () => {
  it('trims and lowercases valid addresses', () => {
    assert.equal(parsed(emailSchema, 'alice@example.com'), 'alice@example.com');
    assert.equal(parsed(emailSchema, '  Frank.Miller@EXAMPLE.COM '), 'frank.miller@example.com');
    assert.equal(
      parsed(emailSchema, "o'neil+tag@sub.example.co.uk"),
      "o'neil+tag@sub.example.co.uk",
    );
  });

  it('puts the address in the error message', () => {
    assert.equal(
      failure(emailSchema, ' bob.smith(at)example.com '),
      '"bob.smith(at)example.com" is not a valid email address',
    );
  });

  it('gives one specific reason for empty and overlong input', () => {
    assert.equal(failure(emailSchema, '   '), 'is empty');
    assert.match(failure(emailSchema, `${'a'.repeat(250)}@example.com`), /longer than 254/);
  });

  const invalid: unknown[] = [
    'plainaddress',
    '@example.com',
    'user@',
    'user@example',
    'user@@example.com',
    '.user@example.com',
    'us..er@example.com',
    'user@-example.com',
    'user@example.c',
    'user name@example.com',
    42,
    null,
  ];

  for (const input of invalid) {
    it(`rejects ${JSON.stringify(input)}`, () => {
      failure(emailSchema, input);
    });
  }
});

describe('rolesSchema', () => {
  const cases: [unknown, string[]][] = [
    ['admin, editor ,  manager', ['admin', 'editor', 'manager']],
    [['viewer', ' '], ['viewer']],
    [null, []],
    [undefined, []],
    ['admin', ['admin']],
    [' , ,', []],
    [
      ['Admin', 'admin', ' EDITOR '],
      ['admin', 'editor'],
    ],
  ];

  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () =>
      assert.deepEqual(parsed(rolesSchema, input), expected));
  }

  it('rejects non-string values instead of coercing them', () => {
    assert.match(failure(rolesSchema, ['viewer', 7]), /non-string value: 7/);
    assert.match(failure(rolesSchema, 42), /comma-separated string or an array/);
  });
});

describe('size limits', () => {
  it('rejects oversized values instead of storing them', () => {
    const manyRoles = Array.from({ length: 51 }, (_, i) => `role${i}`);

    assert.match(failure(rolesSchema, manyRoles), /more than 50 roles/);
    assert.match(failure(rolesSchema, ['x'.repeat(65)]), /role longer than 64/);
    assert.match(failure(eventIdSchema, 'x'.repeat(129)), /longer than 128/);
    assert.match(failure(dateSchema, '2021-04-01'.padEnd(65, ' ')), /longer than 64/);
  });

  it('accepts values at the limits', () => {
    const roles = Array.from({ length: 50 }, (_, i) => `role${i}`);

    assert.equal(parsed(rolesSchema, roles).length, 50);
    assert.equal(parsed(eventIdSchema, 'x'.repeat(128)), 'x'.repeat(128));
  });
});
