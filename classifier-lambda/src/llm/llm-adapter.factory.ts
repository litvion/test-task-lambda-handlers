import type { AppConfig } from '../config.js';
import { ProviderName } from '../enums/provider-name.enum.js';
import { AnthropicAdapter } from './anthropic.adapter.impl.js';
import type { LlmAdapter } from './llm.adapter.js';
import { MockAdapter } from './mock.adapter.impl.js';

// New provider: implement LlmAdapter and add a case here; modes and the processor don't change.
export function createLlmAdapter(config: AppConfig): LlmAdapter {
  switch (config.provider) {
    case ProviderName.Mock:
      return new MockAdapter();
    case ProviderName.Anthropic:
      return new AnthropicAdapter({ apiKey: config.anthropicApiKey, model: config.anthropicModel });
  }
}
