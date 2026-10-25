import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ~/deploy.sh has already reset the checkout to the new commit when scripts/deploy.sh runs. A deploy that
// stops before the restart must put that commit back, or the next deploy's HEAD@{1} rollback target is a
// commit that was never installed or health-checked while the old process keeps serving.
const pin = readFileSync('.bun-version', 'utf8').trim();

const cases = [
  { name: 'a mismatched runtime', version: '0.0.0', pinned: true, migrateRc: 0, reinstalls: false },
  { name: 'a missing pin', version: pin, pinned: false, migrateRc: 0, reinstalls: false },
  { name: 'a failed migration', version: pin, pinned: true, migrateRc: 1, reinstalls: true },
];

test.each(cases)('deploy stopped by $name restores the previous commit without a restart', (c) => {
  const dir = mkdtempSync(join(tmpdir(), 'beacon-runtime-'));
  const app = join(dir, 'app');
  const calls = join(dir, 'calls');
  const git = (...args: string[]) =>
    spawnSync('git', ['-C', app, ...args], { encoding: 'utf8' }).stdout.trim();
  try {
    spawnSync('git', ['init', '-q', app]);
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    writeFileSync(join(app, '.bun-version'), `${pin}\n`);
    git('add', '.');
    git('commit', '-qm', 'previous');
    const prev = git('rev-parse', 'HEAD');
    if (!c.pinned) git('rm', '-q', '.bun-version');
    writeFileSync(join(app, 'next.txt'), 'next\n');
    git('add', '.');
    git('commit', '-qm', 'next');

    const bun = join(dir, 'bun');
    writeFileSync(
      bun,
      `#!/bin/bash\necho "bun $*" >> "$CALLS"\n[ "$1" = --version ] && echo ${c.version}\n[ "$1" = run ] && exit ${c.migrateRc}\nexit 0\n`,
      { mode: 0o755 },
    );
    writeFileSync(join(dir, 'sudo'), '#!/bin/bash\necho "sudo $*" >> "$CALLS"\n', { mode: 0o755 });
    writeFileSync(join(dir, 'env'), '');

    const result = spawnSync('bash', ['scripts/deploy.sh'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        APP_DIR: app,
        BUN: bun,
        CALLS: calls,
        ENV_FILE: join(dir, 'env'),
        PATH: `${dir}:${process.env.PATH}`,
      },
    });
    const log = existsSync(calls) ? readFileSync(calls, 'utf8') : '';

    expect(result.status).toBe(3);
    expect(git('rev-parse', 'HEAD')).toBe(prev);
    expect(log).not.toContain('sudo');
    expect(
      log
        .split('\n')
        .filter((l) => l === 'bun install --frozen-lockfile --production --ignore-scripts').length,
    ).toBe(c.reinstalls ? 2 : 0);
    if (c.version !== pin) expect(result.stderr).toContain(`expected ${pin}, actual 0.0.0`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
