#!/usr/bin/env node
import { existsSync } from 'node:fs';

const cliUrl = new URL('../dist/src/cli.js', import.meta.url);

if (!existsSync(cliUrl)) {
  console.error(
    'Compiled code not found. Run `npm install` (it builds automatically) or `npm run build`.',
  );
  process.exit(1);
}

const { runCli } = await import(cliUrl.href);

process.exitCode = await runCli(process.argv.slice(2));
