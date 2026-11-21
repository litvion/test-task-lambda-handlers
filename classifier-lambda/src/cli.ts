import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { EmailProcessor } from './email.processor.js';
import { ModeName } from './enums/mode-name.enum.js';
import { ProviderName } from './enums/provider-name.enum.js';
import { InputError } from './errors.js';
import { ErrorHelper } from './helpers/error.helper.js';
import { createLlmAdapter } from './llm/llm-adapter.factory.js';
import { createLogger, LOG_FORMATS, LOG_LEVELS, logFormatSchema } from './logger.js';

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_BAD_USAGE = 2;

const USAGE = `Usage: node app/run.js --input <emails.json> --mode <mode> [options]

  -i, --input <path>      JSON file with an array of { id, subject, body } (required)
  -m, --mode <mode>       ${Object.values(ModeName).join(' | ')} (required)
  -l, --log-level <lvl>   ${LOG_LEVELS.join(' | ')} (default: LOG_LEVEL or INFO)
      --log-format <fmt>  ${LOG_FORMATS.join(' | ')} (default: pretty in a terminal, else json)
  -h, --help              show this help

Settings (PROVIDER, ANTHROPIC_API_KEY, ...) come from the environment or a .env file.`;

export async function runCli(argv: string[]): Promise<number> {
  let values;

  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        input: { type: 'string', short: 'i' },
        mode: { type: 'string', short: 'm' },
        'log-level': { type: 'string', short: 'l' },
        'log-format': { type: 'string' },
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

  if (!values.input || !values.mode) {
    console.error(`--input and --mode are required\n\n${USAGE}`);

    return EXIT_BAD_USAGE;
  }

  // Readable lines in a terminal; JSON when stderr is piped or redirected, so it stays parseable.
  const logFormat = logFormatSchema.safeParse(
    values['log-format'] ?? (process.stderr.isTTY ? 'pretty' : 'json'),
  );

  if (!logFormat.success) {
    console.error(`--log-format must be one of: ${LOG_FORMATS.join(', ')}\n\n${USAGE}`);

    return EXIT_BAD_USAGE;
  }

  // Variables already set in the shell win over .env.
  if (existsSync('.env')) process.loadEnvFile('.env');

  let config;

  try {
    const logLevel = values['log-level'];

    config = loadConfig(logLevel ? { ...process.env, LOG_LEVEL: logLevel } : process.env);
  } catch (err) {
    console.error(ErrorHelper.getMessage(err));

    return EXIT_BAD_USAGE;
  }

  const logger = createLogger(config.logLevel, logFormat.data);
  const processor = new EmailProcessor({ llmAdapter: createLlmAdapter(config), config, logger });

  logger.appendKeys({ requestId: `local-${randomUUID()}` });

  if (config.provider === ProviderName.Mock) {
    logger.warn(
      'PROVIDER=mock: results come from offline keyword rules, not a model. ' +
        'Set PROVIDER=anthropic and ANTHROPIC_API_KEY to use Claude.',
    );
  }

  try {
    const emails: unknown = JSON.parse(await readFile(values.input, 'utf8'));
    const { results } = await processor.process({ mode: values.mode, emails });

    process.stdout.write(JSON.stringify(results, null, 2) + '\n');

    return EXIT_OK;
  } catch (err) {
    logger.error('Run failed', { error: ErrorHelper.getMessage(err) });

    return err instanceof InputError ? EXIT_BAD_USAGE : EXIT_FAILED;
  }
}
