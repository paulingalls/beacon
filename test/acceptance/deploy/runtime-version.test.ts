import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pin = readFileSync('.bun-version', 'utf8').trim();
const migrate = JSON.parse(readFileSync('package.json', 'utf8')).scripts.migrate;

test('service ignores planted dotenv and preserves its explicit environment', () => {
  const dir = mkdtempSync(join(tmpdir(), 'beacon-service-'));
  try {
    mkdirSync(join(dir, 'apps/server/src'), { recursive: true });
    writeFileSync(join(dir, '.env.local'), 'PLANTED=dotenv\nEXPLICIT=planted\n');
    writeFileSync(
      join(dir, 'apps/server/src/server.ts'),
      'console.log(JSON.stringify([process.env.PLANTED, process.env.EXPLICIT]));',
    );
    const args = readFileSync('deploy/beacon.service', 'utf8')
      .match(/^ExecStart=.+$/m)![0]
      .split(' ')
      .slice(1);
    const result = spawnSync(process.execPath, args, {
      cwd: dir,
      env: { ...process.env, NODE_ENV: 'production', EXPLICIT: 'operator' },
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([null, 'operator']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const failure of ['mismatched runtime', 'missing pin', 'failed migration', 'failed install']) {
  test(`deploy stopped by ${failure} restores the previous commit without a restart`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'beacon-runtime-'));
    const app = join(dir, 'app');
    const calls = join(dir, 'calls');
    const probe = join(dir, 'probe');
    const requests: string[] = [];
    const registry = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req) {
        requests.push(new URL(req.url).pathname);
        return new Response('missing', { status: 404 });
      },
    });
    const git = (...args: string[]) =>
      spawnSync('git', ['-C', app, ...args], { encoding: 'utf8' }).stdout.trim();
    try {
      spawnSync('git', ['init', '-q', app]);
      git('config', 'user.email', 't@example.com');
      git('config', 'user.name', 't');
      mkdirSync(join(app, 'apps/server/src/storage'), { recursive: true });
      writeFileSync(join(app, '.bun-version'), `${pin}\n`);
      writeFileSync(join(app, '.gitignore'), '.env.*\nnode_modules/\n');
      writeFileSync(
        join(app, 'package.json'),
        JSON.stringify({ name: 'runtime-fixture', scripts: { migrate } }),
      );
      spawnSync(process.execPath, ['--no-env-file', 'install'], { cwd: app });
      writeFileSync(join(app, 'bunfig.toml'), `[install]\nregistry = "${registry.url}trusted/"\n`);
      writeFileSync(
        join(app, 'apps/server/src/storage/migrate.ts'),
        `await Bun.write(process.env.PROBE!, JSON.stringify([process.env.PLANTED, process.env.EXPLICIT])); process.exit(1);`,
      );
      git('add', '.');
      git('commit', '-qm', 'previous');
      const prev = git('rev-parse', 'HEAD');
      if (failure === 'missing pin') git('rm', '-q', '.bun-version');
      if (failure === 'mismatched runtime') writeFileSync(join(app, '.bun-version'), '0.0.0\n');
      if (failure === 'failed install') {
        writeFileSync(
          join(app, 'package.json'),
          JSON.stringify({
            name: 'runtime-fixture',
            dependencies: { 'beacon-fixture-missing': '1.0.0' },
          }),
        );
        writeFileSync(
          join(app, 'bun.lock'),
          '{"lockfileVersion":1,"workspaces":{"":{"name":"runtime-fixture","dependencies":{"beacon-fixture-missing":"1.0.0"}}},"packages":{}}',
        );
      }
      writeFileSync(join(app, 'next.txt'), 'next\n');
      git('add', '.');
      git('commit', '-qm', 'next');
      writeFileSync(
        join(app, '.env.local'),
        `PLANTED=dotenv\nBUN_CONFIG_REGISTRY=${registry.url}planted/\n`,
      );
      const bun = join(dir, 'bun');
      writeFileSync(
        bun,
        `#!/bin/bash\necho "bun $*" >> "$CALLS"\nexec '${process.execPath}' "$@"\n`,
        { mode: 0o755 },
      );
      writeFileSync(join(dir, 'sudo'), '#!/bin/bash\necho "sudo $*" >> "$CALLS"\n', {
        mode: 0o755,
      });
      writeFileSync(join(dir, 'env'), 'EXPLICIT=operator\n');
      const p = Bun.spawn(['bash', 'scripts/deploy.sh'], {
        env: {
          ...process.env,
          NODE_ENV: 'production',
          APP_DIR: app,
          BUN: bun,
          CALLS: calls,
          PROBE: probe,
          ENV_FILE: join(dir, 'env'),
          PATH: `${dir}:${process.env.PATH}`,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [code, stderr] = await Promise.all([
        p.exited,
        new Response(p.stderr).text(),
        new Response(p.stdout).text(),
      ]);
      const log = existsSync(calls) ? readFileSync(calls, 'utf8') : '';
      expect(code, stderr).toBe(3);
      expect(git('rev-parse', 'HEAD')).toBe(prev);
      expect(log).not.toContain('sudo');
      if (failure === 'mismatched runtime')
        expect(stderr).toContain(`expected 0.0.0, actual ${pin}`);
      if (failure === 'failed migration')
        expect(JSON.parse(readFileSync(probe, 'utf8'))).toEqual([null, 'operator']);
      if (failure === 'failed install') {
        expect(requests.some((path) => path.startsWith('/trusted/'))).toBe(true);
        expect(requests.filter((path) => path.startsWith('/planted/'))).toEqual([]);
      }
      expect(
        log
          .split('\n')
          .filter(
            (l) =>
              l === 'bun --no-env-file install --frozen-lockfile --production --ignore-scripts',
          ),
      ).toHaveLength(failure.startsWith('failed') ? 2 : 0);
    } finally {
      registry.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
