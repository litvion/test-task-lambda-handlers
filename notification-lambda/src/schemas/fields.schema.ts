import { z } from 'zod';
import { DateHelper } from '../helpers/date.helper.js';

const MAX_EMAIL_LENGTH = 254;
const MAX_NAME_LENGTH = 255;
const MAX_DATE_LENGTH = 64;
// Size limits keep a single malformed or abusive event from storing megabytes of JSON.
const MAX_ROLES = 50;
const MAX_ROLE_LENGTH = 64;
// Matches the EventID column suggested in schema.sql.
const MAX_EVENT_ID_LENGTH = 128;

const requiredOr = (typeError: string) => (issue: { input: unknown }) =>
  issue.input === undefined || issue.input === null ? 'is required' : typeError;

// Lowercased, so the same address written in different case is one recipient.
export const emailSchema = z
  .string({ error: requiredOr('must be a string') })
  .trim()
  .min(1, { error: 'is empty', abort: true })
  .max(MAX_EMAIL_LENGTH, { error: `is longer than ${MAX_EMAIL_LENGTH} characters`, abort: true })
  .pipe(z.email({ error: (issue) => `"${String(issue.input)}" is not a valid email address` }))
  .transform((email) => email.toLowerCase());

export const dateSchema = z
  .string({ error: requiredOr('must be a date string') })
  .max(MAX_DATE_LENGTH, { error: `is longer than ${MAX_DATE_LENGTH} characters`, abort: true })
  .transform((value, ctx) => {
    const result = DateHelper.normalize(value);

    if (!result.ok) {
      ctx.addIssue({ code: 'custom', message: result.reason });

      return z.NEVER;
    }

    return result.iso;
  });

// A comma-separated string or an array becomes trimmed, lowercased, unique strings;
// blanks are dropped and null or missing becomes [].
export const rolesSchema = z
  .union([z.string().transform((roles) => roles.split(',')), z.array(z.unknown())], {
    error: 'must be a comma-separated string or an array of strings',
  })
  .nullish()
  .transform((roles) => roles ?? [])
  .pipe(
    z.array(
      z.string({ error: (issue) => `contains a non-string value: ${JSON.stringify(issue.input)}` }),
    ),
  )
  .transform((roles) => [
    ...new Set(roles.map((role) => role.trim().toLowerCase()).filter(Boolean)),
  ])
  .pipe(
    z
      .array(
        z
          .string()
          .max(MAX_ROLE_LENGTH, `contains a role longer than ${MAX_ROLE_LENGTH} characters`),
      )
      .max(MAX_ROLES, `has more than ${MAX_ROLES} roles`),
  );

export const nameSchema = z
  .string({ error: requiredOr('must be a string') })
  .trim()
  .min(1, 'is empty')
  .max(MAX_NAME_LENGTH, `is longer than ${MAX_NAME_LENGTH} characters`);

// Stringified, so 101 and "101" are treated as the same event.
export const eventIdSchema = z
  .union([z.string().trim().min(1), z.number().int()], {
    error: 'must be a non-empty string or an integer',
  })
  .transform(String)
  .pipe(z.string().max(MAX_EVENT_ID_LENGTH, `is longer than ${MAX_EVENT_ID_LENGTH} characters`))
  .optional();
