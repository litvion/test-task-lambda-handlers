import { z } from 'zod';
import { ModeName } from '../enums/mode-name.enum.js';
import { TextHelper } from '../helpers/text.helper.js';

const MODE_NAMES = Object.values(ModeName).join(', ');

const ID_ERROR = '"id" must be a non-empty string or a number';

export const emailIdSchema = z.union(
  [z.string().refine((id) => id.trim() !== '', { error: ID_ERROR }), z.number()],
  { error: ID_ERROR },
);

// Missing or null subject/body count as empty; whitespace is collapsed because it costs tokens.
const textSchema = (field: string) =>
  z
    .string({ error: `"${field}" must be a string` })
    .nullish()
    .transform((text) => TextHelper.normalizeWhitespace(text ?? ''));

export const emailItemSchema = z.object(
  { id: emailIdSchema, subject: textSchema('subject'), body: textSchema('body') },
  { error: 'item is not an object' },
);

export const classifierEventSchema = z.object(
  {
    mode: z.enum(ModeName, {
      error: (issue) => `unknown mode ${JSON.stringify(issue.input)} (supported: ${MODE_NAMES})`,
    }),
    emails: z.array(z.unknown(), { error: '"emails" must be an array' }),
  },
  { error: 'event must be an object: { mode, emails }' },
);

export type EmailId = z.infer<typeof emailIdSchema>;
