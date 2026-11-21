import { ModeName } from '../enums/mode-name.enum.js';
import { ProviderName } from '../enums/provider-name.enum.js';
import { ProviderError } from '../errors.js';
import { BatchPromptHelper, type WireEmail } from '../helpers/batch-prompt.helper.js';
import { TextHelper } from '../helpers/text.helper.js';
import type { CompletionRequest, CompletionResponse, LlmAdapter } from './llm.adapter.js';

// Offline stand-in for a model: keyword rules answering in the same JSON format as Claude,
// so parsing, validation and retries run without an API key.
const TOPIC_KEYWORDS: Record<string, string> = {
  finance: 'invoice|payment|overdue|refund|billing|budget|expense|paid|pay',
  technical:
    'deploy|bug|api|server|engineering|release|incident|database|sprint|outage|migration|latency',
  hr: 'retreat|vacation|leave|onboarding|hiring|benefits|employees|payroll|team-building|colleagues',
  marketing: 'campaign|newsletter|brand|webinar|announcement|social media|launch|promotion|press',
  sales: 'quote|proposal|deal|pricing|demo|lead|renewal|discount|purchase',
  legal: 'contract|nda|gdpr|compliance|agreement|terms|liability|clause',
  support: 'ticket|help|password|reset|unable|error|complaint|login|log in|locked',
};

const TOPIC_PATTERNS = Object.entries(TOPIC_KEYWORDS).map(([topic, keywords]) => ({
  topic,
  pattern: new RegExp(`\\b(${keywords})\\b`, 'gi'),
}));

const MAX_TOPICS = 3;
const GREETING = /^(dear|hi|hello|hey|good (morning|afternoon|evening))\b[^,.!?:]{0,40}[,!:]\s*/i;
const CHARS_PER_TOKEN = 4;

export const SIMULATED_ERROR_MARKER = '[simulate-provider-error]';

export class MockAdapter implements LlmAdapter {
  readonly name = ProviderName.Mock;

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const emails = BatchPromptHelper.decode(request.prompt);

    if (emails.some((email) => email.b.includes(SIMULATED_ERROR_MARKER))) {
      throw new ProviderError('mock provider: simulated upstream failure');
    }

    const results = emails.map((email) =>
      request.task === ModeName.Classify
        ? { k: email.k, topics: this.classify(email) }
        : { k: email.k, summary: this.summarize(email) },
    );
    const text = JSON.stringify({ results });

    return {
      text,
      usage: {
        inputTokens: this.estimateTokens(request.system + request.prompt),
        outputTokens: this.estimateTokens(text),
      },
    };
  }

  // Runs locally, so it costs nothing; its token counts are estimates.
  estimateCostUsd(): number {
    return 0;
  }

  private classify(email: WireEmail): string[] {
    const text = `${email.s} ${email.b}`;

    return TOPIC_PATTERNS.map(({ topic, pattern }) => ({
      topic,
      hits: text.match(pattern)?.length ?? 0,
    }))
      .filter(({ hits }) => hits > 0)
      .sort((a, b) => b.hits - a.hits)
      .slice(0, MAX_TOPICS)
      .map(({ topic }) => topic);
  }

  private summarize(email: WireEmail): string {
    const body = email.b.replace(GREETING, '');
    const summary = body ? TextHelper.firstSentences(body, 2) : email.s;

    return summary.charAt(0).toUpperCase() + summary.slice(1);
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN);
  }
}
