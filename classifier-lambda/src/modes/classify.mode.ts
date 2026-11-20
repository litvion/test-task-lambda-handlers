import { z } from 'zod';
import { FALLBACK_TOPIC } from '../config.js';
import { ModeName } from '../enums/mode-name.enum.js';
import { BatchPromptHelper } from '../helpers/batch-prompt.helper.js';
import type { Mode } from './mode.interface.js';

const MAX_TOPICS = 3;

const entrySchema = z.object({ k: z.number().int().nonnegative(), topics: z.array(z.unknown()) });

export interface ClassifyOutput {
  topics: string[];
}

export class ClassifyMode implements Mode<ClassifyOutput> {
  readonly name = ModeName.Classify;
  readonly outputTokensPerEmail = 20;
  readonly systemPrompt: string;
  private readonly allowedTopics: Set<string>;

  constructor(topics: readonly string[]) {
    this.allowedTopics = new Set(topics);
    this.systemPrompt = [
      'Classify each email into topics.',
      `Allowed topics: ${topics.join(', ')}.`,
      `Give 1-${MAX_TOPICS} topics per email, most relevant first; use "${FALLBACK_TOPIC}" only if none fit.`,
      BatchPromptHelper.INPUT_RULES,
      'Reply with JSON only: {"results":[{"k":0,"topics":["finance"]}]}',
    ].join('\n');
  }

  parseReply(reply: string, batchSize: number): Map<number, ClassifyOutput> {
    const values = new Map<number, ClassifyOutput>();

    for (const entry of BatchPromptHelper.parseResults(reply)) {
      const parsed = entrySchema.safeParse(entry);

      if (parsed.success && parsed.data.k < batchSize) {
        values.set(parsed.data.k, { topics: this.normalizeTopics(parsed.data.topics) });
      }
    }

    return values;
  }

  // Model output isn't trusted: keep only allowed topics, fall back to "other".
  normalizeTopics(topics: readonly unknown[]): string[] {
    const allowed = topics
      .filter((topic) => typeof topic === 'string')
      .map((topic) => topic.trim().toLowerCase())
      .filter((topic) => this.allowedTopics.has(topic));
    const unique = [...new Set(allowed)].slice(0, MAX_TOPICS);

    return unique.length > 0 ? unique : [FALLBACK_TOPIC];
  }
}
