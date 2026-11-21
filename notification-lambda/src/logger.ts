import { Logger, type LogItem } from '@aws-lambda-powertools/logger';
import { styleText } from 'node:util';
import { z } from 'zod';

export const LOG_LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export const logLevelSchema = z.string().trim().toUpperCase().pipe(z.enum(LOG_LEVELS));

export const LOG_FORMATS = ['json', 'pretty'] as const;

export type LogFormat = (typeof LOG_FORMATS)[number];

export const logFormatSchema = z.string().trim().toLowerCase().pipe(z.enum(LOG_FORMATS));

type Style = Parameters<typeof styleText>[0];

const SERVICE_NAME = 'notification-handler';
// Present on every line (requestId is random per local run), so the pretty format leaves them out.
const PRETTY_HIDDEN_KEYS = new Set([
  'level',
  'message',
  'timestamp',
  'service',
  'sampling_rate',
  'requestId',
]);
const LEVEL_STYLES: Record<string, Style> = {
  DEBUG: 'gray',
  INFO: 'cyan',
  WARN: 'yellow',
  ERROR: 'red',
};
const BARE_VALUE = /^[^\s"=]+$/;

// Logs go to stderr so stdout holds only the JSON report (`> report.json` stays clean).
class JsonLogger extends Logger {
  protected override printLog(_logLevel: number, log: LogItem): void {
    process.stderr.write(JSON.stringify(log.getAttributes(), this.getJsonReplacer()) + '\n');
  }
}

// For a person at a terminal: one line per entry, `time LEVEL message key=value ...`.
// styleText drops the colours when stderr isn't a terminal or NO_COLOR is set.
class PrettyLogger extends Logger {
  protected override printLog(_logLevel: number, log: LogItem): void {
    const attributes = log.getAttributes();
    const level = String(attributes.level);
    const fields = Object.entries(attributes)
      .filter(([key, value]) => !PRETTY_HIDDEN_KEYS.has(key) && value !== undefined)
      .map(([key, value]) => `${this.paint('dim', `${key}=`)}${this.formatValue(value)}`);
    const line = [
      this.paint('dim', String(attributes.timestamp).slice(11, 23)),
      this.paint(LEVEL_STYLES[level] ?? 'white', level.padEnd(5)),
      this.paint('bold', String(attributes.message)),
      ...fields,
    ].join(' ');

    process.stderr.write(line + '\n');
  }

  private formatValue(value: unknown): string {
    if (typeof value === 'string') return BARE_VALUE.test(value) ? value : JSON.stringify(value);

    return JSON.stringify(value, this.getJsonReplacer()) ?? String(value);
  }

  private paint(style: Style, text: string): string {
    return styleText(style, text, { stream: process.stderr });
  }
}

// Lambda always logs JSON, which CloudWatch Logs Insights can query; pretty is for local runs.
export function createLogger(logLevel: LogLevel | 'SILENT', format: LogFormat = 'json'): Logger {
  const options = { serviceName: SERVICE_NAME, logLevel };

  return format === 'pretty' ? new PrettyLogger(options) : new JsonLogger(options);
}
