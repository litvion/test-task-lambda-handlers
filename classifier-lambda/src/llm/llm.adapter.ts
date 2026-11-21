import type { ModeName } from '../enums/mode-name.enum.js';

export interface CompletionRequest {
  task: ModeName;
  system: string;
  prompt: string;
  maxTokens: number;
  signal?: AbortSignal;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface CompletionResponse {
  text: string;
  usage: TokenUsage;
}

export interface LlmAdapter {
  readonly name: string;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
  // undefined when the price is unknown, so a missing price never shows up as $0.
  estimateCostUsd(usage: TokenUsage): number | undefined;
}
