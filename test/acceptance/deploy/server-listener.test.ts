import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';

const address = Object.values(networkInterfaces())
  .flat()
  .find((i) => i?.family === 'IPv4' && !i.internal)?.address;
const DATABASE_URL = 'postgres://stub:stub@127.0.0.1:1/stub';
const health = (host: string, port: string) =>
  fetch(`http://${host}:${port}/health`, { proxy: null, signal: AbortSignal.timeout(2000) });

test.each([undefined, '', '0.0.0.0'])('production listener with HOST=%s', async (HOST) => {
  if (!address) throw new Error('A non-loopback IPv4 interface is required');
  const env = { ...process.env, HOST, PORT: '0', DATABASE_URL };
  const child = Bun.spawn([process.execPath, 'apps/server/src/server.ts'], {
    env,
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const deadline = setTimeout(() => child.kill('SIGKILL'), 5000);
  try {
    const output = await child.stdout.getReader().read();
    const port = new TextDecoder().decode(output.value).match(/:(\d+)/)?.[1];
    if (!port || port === '0') throw new Error('Startup must report the actual listening port');
    const local = await health('127.0.0.1', port);
    expect(local.status).toBe(200);
    expect(await local.json()).toEqual({
      status: 'ok',
      commit: Bun.spawnSync(['git', 'rev-parse', 'HEAD']).stdout.toString().trim(),
    });
    if (HOST) expect((await health(address, port)).status).toBe(200);
    else await expect(health(address, port)).rejects.toThrow('ECONNREFUSED');
  } finally {
    clearTimeout(deadline);
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 2000);
    await child.exited;
    clearTimeout(force);
  }
}, 10000);

test('boot identity stays fixed until the production process restarts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beacon-boot-'));
  const env = { ...process.env };
  for (const key of Bun.spawnSync(['git', 'rev-parse', '--local-env-vars'])
    .stdout.toString()
    .trim()
    .split('\n'))
    Reflect.deleteProperty(env, key);
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(['git', '-C', dir, ...args], { env });
    if (result.exitCode) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const boot = async () => {
    const processChild = Bun.spawn([process.execPath, 'apps/server/src/server.ts'], {
      env: {
        ...env,
        GIT_DIR: join(dir, '.git'),
        BEACON_COMMIT: 'f'.repeat(40),
        DATABASE_URL,
        HOST: '127.0.0.1',
        PORT: '0',
      },
      stdout: 'pipe',
      stderr: 'inherit',
    });
    child = processChild;
    const output = await processChild.stdout.getReader().read();
    const port = new TextDecoder().decode(output.value).match(/:(\d+)/)?.[1];
    if (!port) throw new Error('No listening port');
    return port;
  };
  const stop = async () => {
    child?.kill('SIGTERM');
    const timer = setTimeout(() => child?.kill('SIGKILL'), 2000);
    try {
      await child?.exited;
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    git('init', '-q');
    git('config', 'user.name', 'test');
    git('config', 'user.email', 'test@test');
    git('commit', '--allow-empty', '-qm', 'A');
    const first = git('rev-parse', 'HEAD');
    const port = await boot();
    expect(await (await health('127.0.0.1', port)).json()).toEqual({ status: 'ok', commit: first });
    git('commit', '--allow-empty', '-qm', 'B');
    const second = git('rev-parse', 'HEAD');
    expect(second).not.toBe(first);
    expect(await (await health('127.0.0.1', port)).json()).toEqual({ status: 'ok', commit: first });
    await stop();
    expect(await (await health('127.0.0.1', await boot())).json()).toEqual({
      status: 'ok',
      commit: second,
    });
  } finally {
    await stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 10000);
