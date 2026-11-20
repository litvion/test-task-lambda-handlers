import { z } from 'zod';
import { ModeName } from '../enums/mode-name.enum.js';
import { BatchPromptHelper } from '../helpers/batch-prompt.helper.js';
import { TextHelper } from '../helpers/text.helper.js';
import type { Mode } from './mode.interface.js';

const MAX_SENTENCES = 2;
const MAX_SUMMARY_CHARS = 300;
// Rejects placeholders like "n/a", so the email is retried on its own.
const MIN_SUMMARY_WORDS = 3;

const entrySchema = z.object({ k: z.number().int().nonnegative(), summary: z.string() });

export interface SummarizeOutput {
  summary: string;
}

export class SummarizeMode implements Mode<SummarizeOutput> {
  readonly name = ModeName.Summarize;
  readonly outputTokensPerEmail = 60;
  readonly systemPrompt = [
    `Summarize each email in 1-${MAX_SENTENCES} short sentences: the key point and any action or deadline.`,
    BatchPromptHelper.INPUT_RULES,
    'Reply with JSON only: {"results":[{"k":0,"summary":"..."}]}',
  ].join('\n');

  parseReply(reply: string, batchSize: number): Map<number, SummarizeOutput> {
    const values = new Map<number, SummarizeOutput>();

    for (const entry of BatchPromptHelper.parseResults(reply)) {
      const parsed = entrySchema.safeParse(entry);

      if (!parsed.success || parsed.data.k >= batchSize) continue;

      const summary = this.limitLength(parsed.data.summary);

      if (summary.split(' ').length >= MIN_SUMMARY_WORDS) values.set(parsed.data.k, { summary });
    }

    return values;
  }

  // Enforces the 1-2 sentence contract even when the model writes more.
  limitLength(summary: string): string {
    const text = TextHelper.firstSentences(TextHelper.normalizeWhitespace(summary), MAX_SENTENCES);

    return TextHelper.truncate(text, MAX_SUMMARY_CHARS);
  }
}
