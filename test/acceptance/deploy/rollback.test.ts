import { expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const retries = 20;
for (const [name, healthyAfter, commits, code, message] of [
  ['healthy first restart', 0, 2, 0, 'Deploy healthy'],
  ['unhealthy new commit', retries, 2, 1, 'Rolled back'],
  ['rollback also unhealthy', 2 * retries + 1, 2, 2, 'manual intervention required'],
  ['absent reflog fallback', retries, 1, 1, 'Rolled back'],
] as const) {
  test(`deploy.sh rollback: ${name}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'beacon-deploy-'));
    const app = join(root, 'app');
    const bin = join(root, 'bin');
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', app, ...args], { encoding: 'utf8' }).trim();
    const stub = (name: string, body: string) =>
      writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
    try {
      mkdirSync(bin);
      spawnSync('git', ['init', '-q', '-b', 'main', app]);
      git('config', 'user.email', 't@t');
      git('config', 'user.name', 't');
      writeFileSync(join(app, '.bun-version'), readFileSync('.bun-version'));
      const revisions = [];
      for (let i = 0; i < commits; i++) {
        writeFileSync(join(app, 'v'), String(i));
        git('add', '-A');
        git('commit', '-qm', String(i));
        revisions.push(git('rev-parse', 'HEAD'));
      }
      writeFileSync(join(root, 'env'), 'DATABASE_URL=postgres://stub/never-used\n');
      stub('sleep', 'exit 0');
      stub('sudo', 'exec "$@"');
      stub('systemctl', 'exit 0');
      stub(
        'curl',
        'n=$(cat "$CURL_COUNTER_FILE" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$CURL_COUNTER_FILE"; [ "$n" -gt "$CURL_HEALTHY_AFTER" ]',
      );
      stub('bun', 'if [ "$1" = --version ]; then cat .bun-version; fi; exit 0');
      const result = spawnSync('bash', ['scripts/deploy.sh'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          APP_DIR: app,
          ENV_FILE: join(root, 'env'),
          BUN: join(bin, 'bun'),
          HEALTH_RETRIES: String(retries),
          CURL_COUNTER_FILE: join(root, 'counter'),
          CURL_HEALTHY_AFTER: String(healthyAfter),
        },
      });
      expect(result.status, result.stderr).toBe(code);
      expect(result.stdout).toContain(message);
      expect(git('rev-parse', 'HEAD')).toBe(code === 0 ? revisions.at(-1) : revisions[0]);
      if (commits === 1)
        expect(result.stdout).toContain(`rollback target: ${revisions[0]?.slice(0, 7)}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
