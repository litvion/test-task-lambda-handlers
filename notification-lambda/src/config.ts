import { z } from 'zod';
import { type LogLevel, logLevelSchema } from './logger.js';

const TINYINT_UNSIGNED_MAX = 255;
const INT_UNSIGNED_MAX = 4_294_967_295;

const envSchema = z.object({
  LOG_LEVEL: logLevelSchema.default('INFO'),
  // Notifications come from the system, so 0 (system) is the default creator.
  CREATED_BY_TYPE: z.coerce.number().int().min(0).max(TINYINT_UNSIGNED_MAX).default(0),
  CREATED_BY_ID: z.coerce.number().int().min(0).max(INT_UNSIGNED_MAX).default(0),
  DB_LATENCY_MS: z.coerce.number().int().min(0).max(10_000).default(5),
});

export interface AppConfig {
  logLevel: LogLevel;
  createdByType: number;
  createdById: number;
  dbLatencyMs: number;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const result = envSchema.safeParse(env);

  if (!result.success) {
    const issue = result.error.issues[0]!;
    const key = String(issue.path[0]);

    throw new Error(`Invalid ${key}="${env[key]}": ${issue.message}`);
  }

  const { LOG_LEVEL, CREATED_BY_TYPE, CREATED_BY_ID, DB_LATENCY_MS } = result.data;

  return {
    logLevel: LOG_LEVEL,
    createdByType: CREATED_BY_TYPE,
    createdById: CREATED_BY_ID,
    dbLatencyMs: DB_LATENCY_MS,
  };
}
