import type { Context } from 'aws-lambda';
import { loadConfig } from './config.js';
import { SimulatedMySqlRepository } from './db/simulated-mysql.repository.impl.js';
import { EventRegistry } from './events/event-registry.js';
import { createLogger } from './logger.js';
import { NotificationProcessor, type ProcessingReport } from './notification.processor.js';

// Created once per cold start and reused by warm invocations.
const config = loadConfig();
const logger = createLogger(config.logLevel);
const processor = new NotificationProcessor({
  eventRegistry: new EventRegistry(),
  notificationRepository: new SimulatedMySqlRepository(logger, config.dbLatencyMs),
  config,
  logger,
});

export const handler = async (event: unknown, context: Context): Promise<ProcessingReport> => {
  logger.addContext(context);

  return processor.process(event, { remainingTimeMs: context.getRemainingTimeInMillis() });
};
