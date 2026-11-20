import type { ModeName } from '../enums/mode-name.enum.js';

export interface Mode<T extends object = object> {
  name: ModeName;
  systemPrompt: string;
  outputTokensPerEmail: number;
  parseReply(reply: string, batchSize: number): Map<number, T>;
}
