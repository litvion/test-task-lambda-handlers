import type { ModeName } from '../enums/mode-name.enum.js';

export interface CompletionRequest {
  task: ModeName;
  system: string;
  prompt: string;
  maxTokens: number;
  signal?: AbortSignal;
}

export interface CompletionResponse {
  text: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface LlmAdapter {
  readonly name: string;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
}
