import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { SimulatedMySqlRepository } from './db/simulated-mysql.repository.impl.js';
import { InputError } from './errors.js';
import { ErrorHelper } from './helpers/error.helper.js';
import { EventRegistry } from './events/event-registry.js';
import { createLogger, LOG_LEVELS } from './logger.js';
import { NotificationProcessor } from './notification.processor.js';

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_BAD_USAGE = 2;

const USAGE = `Usage: node app/run.js --input <events.json> [options]

  -i, --input <path>      JSON file with an array of events (required)
  -l, --log-level <lvl>   ${LOG_LEVELS.join(' | ')} (default: LOG_LEVEL or INFO)
      --show-db           also print the simulated Notification table
  -h, --help              show this help`;

export async function runCli(argv: string[]): Promise<number> {
  let values;

  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        input: { type: 'string', short: 'i' },
        'log-level': { type: 'string', short: 'l' },
        'show-db': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (err) {
    console.error(`${ErrorHelper.getMessage(err)}\n\n${USAGE}`);

    return EXIT_BAD_USAGE;
  }

  if (values.help) {
    console.log(USAGE);

    return EXIT_OK;
  }

  if (!values.input) {
    console.error(`--input is required\n\n${USAGE}`);

    return EXIT_BAD_USAGE;
  }

  let config;

  try {
    const logLevel = values['log-level'];

    config = loadConfig(logLevel ? { ...process.env, LOG_LEVEL: logLevel } : process.env);
  } catch (err) {
    console.error(ErrorHelper.getMessage(err));

    return EXIT_BAD_USAGE;
  }

  const logger = createLogger(config.logLevel);
  const repository = new SimulatedMySqlRepository(logger, config.dbLatencyMs);
  const processor = new NotificationProcessor({
    eventRegistry: new EventRegistry(),
    notificationRepository: repository,
    config,
    logger,
  });

  logger.appendKeys({ requestId: `local-${randomUUID()}` });

  try {
    const events: unknown = JSON.parse(await readFile(values.input, 'utf8'));
    const report = await processor.process(events);
    const output = values['show-db'] ? { report, notificationTable: repository.rows } : report;

    process.stdout.write(JSON.stringify(output, null, 2) + '\n');

    return EXIT_OK;
  } catch (err) {
    logger.error('Run failed', { error: ErrorHelper.getMessage(err) });

    return err instanceof InputError ? EXIT_BAD_USAGE : EXIT_FAILED;
  }
}
