import { Logger, type LogItem } from '@aws-lambda-powertools/logger';
import { z } from 'zod';

export const LOG_LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export const logLevelSchema = z.string().trim().toUpperCase().pipe(z.enum(LOG_LEVELS));

// Logs go to stderr so stdout holds only the JSON results (`> results.json` stays clean).
class StderrLogger extends Logger {
  protected override printLog(_logLevel: number, log: LogItem): void {
    process.stderr.write(JSON.stringify(log.getAttributes(), this.getJsonReplacer()) + '\n');
  }
}

export function createLogger(logLevel: LogLevel | 'SILENT'): Logger {
  return new StderrLogger({ serviceName: 'email-classifier', logLevel });
}
