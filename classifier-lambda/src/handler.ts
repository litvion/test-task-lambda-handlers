import type { Context } from 'aws-lambda';
import { loadConfig } from './config.js';
import { EmailProcessor, type ItemResult } from './email.processor.js';
import { createLlmAdapter } from './llm/llm-adapter.factory.js';
import { createLogger } from './logger.js';

// Created once per cold start and reused by warm invocations, so the result cache survives.
const config = loadConfig();
const logger = createLogger(config.logLevel);
const processor = new EmailProcessor({ llmAdapter: createLlmAdapter(config), config, logger });

export const handler = async (event: unknown, context: Context): Promise<ItemResult[]> => {
  logger.addContext(context);

  const { results } = await processor.process(event, {
    remainingTimeMs: context.getRemainingTimeInMillis(),
  });

  return results;
};
