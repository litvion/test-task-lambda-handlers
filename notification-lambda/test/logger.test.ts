import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { createLogger } from '../src/logger.js';

function captureStderr(run: () => void): string[] {
  const lines: string[] = [];
  const write = process.stderr.write;

  process.stderr.write = ((chunk: string) => {
    lines.push(stripVTControlCharacters(String(chunk)));

    return true;
  }) as typeof process.stderr.write;

  try {
    run();
  } finally {
    process.stderr.write = write;
  }

  return lines;
}

describe('createLogger', () => {
  it('writes one JSON object per line by default (Lambda, piped output)', () => {
    const [line] = captureStderr(() => createLogger('INFO').info('Run finished', { total: 2 }));
    const entry = JSON.parse(line!);

    assert.deepEqual([entry.level, entry.message, entry.total], ['INFO', 'Run finished', 2]);
  });

  it('writes a short readable line in the pretty format', () => {
    const [line] = captureStderr(() =>
      createLogger('INFO', 'pretty').warn('Invalid item skipped', {
        index: 3,
        error: 'empty_input',
        reason: 'subject and body are empty',
        ids: [1, 2],
      }),
    );

    assert.match(
      line!,
      /^\d{2}:\d{2}:\d{2}\.\d{3} WARN {2}Invalid item skipped index=3 error=empty_input reason="subject and body are empty" ids=\[1,2\]\n$/,
    );
  });

  it('respects the log level in the pretty format', () => {
    const lines = captureStderr(() => createLogger('WARN', 'pretty').info('hidden'));

    assert.deepEqual(lines, []);
  });
});
