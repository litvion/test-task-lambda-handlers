import { z } from 'zod';
import { ProviderName } from './enums/provider-name.enum.js';
import { type LogLevel, logLevelSchema } from './logger.js';

export const FALLBACK_TOPIC = 'other';

const DEFAULT_TOPICS = [
  'finance',
  'technical',
  'hr',
  'marketing',
  'sales',
  'legal',
  'support',
  FALLBACK_TOPIC,
];

// "other" is always allowed, so classification always has a fallback topic.
const topicsSchema = z
  .string()
  .transform((raw) => raw.split(',').map((topic) => topic.trim().toLowerCase()))
  .transform((topics) => [...new Set([...topics.filter(Boolean), FALLBACK_TOPIC])]);

const envSchema = z
  .object({
    LOG_LEVEL: logLevelSchema.default('INFO'),
    PROVIDER: z.string().trim().toLowerCase().pipe(z.enum(ProviderName)).default(ProviderName.Mock),
    ANTHROPIC_API_KEY: z.string().trim().optional(),
    ANTHROPIC_MODEL: z.string().trim().min(1).default('claude-haiku-5-5'),
    TOPICS: topicsSchema.default(DEFAULT_TOPICS),
    BATCH_SIZE: z.coerce.number().int().min(1).max(50).default(10),
    MAX_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(3),
    MAX_BODY_CHARS: z.coerce.number().int().min(100).max(20_000).default(2000),
    CACHE_MAX_ENTRIES: z.coerce.number().int().min(0).max(100_000).default(1000),
  })
  .refine((env) => env.PROVIDER !== ProviderName.Anthropic || env.ANTHROPIC_API_KEY, {
    path: ['ANTHROPIC_API_KEY'],
    message: 'is required when PROVIDER=anthropic',
  });

export interface AppConfig {
  logLevel: LogLevel;
  provider: ProviderName;
  anthropicApiKey: string | undefined;
  anthropicModel: string;
  topics: string[];
  batchSize: number;
  maxConcurrency: number;
  maxBodyChars: number;
  cacheMaxEntries: number;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const result = envSchema.safeParse(env);

  if (!result.success) {
    const issue = result.error.issues[0]!;
    const key = String(issue.path[0]);

    // Never echo the API key back in an error message.
    if (key === 'ANTHROPIC_API_KEY') throw new Error(`${key} ${issue.message}`);

    throw new Error(`Invalid ${key}="${env[key]}": ${issue.message}`);
  }

  const data = result.data;

  return {
    logLevel: data.LOG_LEVEL,
    provider: data.PROVIDER,
    anthropicApiKey: data.ANTHROPIC_API_KEY || undefined,
    anthropicModel: data.ANTHROPIC_MODEL,
    topics: data.TOPICS,
    batchSize: data.BATCH_SIZE,
    maxConcurrency: data.MAX_CONCURRENCY,
    maxBodyChars: data.MAX_BODY_CHARS,
    cacheMaxEntries: data.CACHE_MAX_ENTRIES,
  };
}
