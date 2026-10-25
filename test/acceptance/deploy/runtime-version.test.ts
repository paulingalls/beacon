import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('deploy refuses a mismatched runtime before any deployment side effect', () => {
  const dir = mkdtempSync(join(tmpdir(), 'beacon-runtime-'));
  const expected = readFileSync('.bun-version', 'utf8').trim();
  const calls = join(dir, 'calls');
  const bun = join(dir, 'bun');
  try {
    writeFileSync(join(dir, '.bun-version'), `${expected}\n`);
    writeFileSync(
      bun,
      '#!/bin/bash\necho "$*" >> "$CALLS"\nif [ "$1" = --version ]; then echo 0.0.0; else exit 91; fi\n',
      { mode: 0o755 },
    );
    for (const name of ['git', 'sudo']) {
      writeFileSync(
        join(dir, name),
        '#!/bin/bash\necho "side-effect $*" >> "$CALLS"\necho stub\n',
        { mode: 0o755 },
      );
    }
    const result = spawnSync('bash', ['scripts/deploy.sh'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        APP_DIR: dir,
        BUN: bun,
        CALLS: calls,
        PATH: `${dir}:${process.env.PATH}`,
      },
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(expected);
    expect(result.stdout + result.stderr).toContain('0.0.0');
    expect(readFileSync(calls, 'utf8').trim()).toBe('--version');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
