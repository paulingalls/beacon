import { expect, test } from 'bun:test';
import { networkInterfaces } from 'node:os';

const address = Object.values(networkInterfaces())
  .flat()
  .find((i) => i?.family === 'IPv4' && !i.internal)?.address;
const DATABASE_URL = 'postgres://stub:stub@127.0.0.1:1/stub';
const health = (host: string, port: string) =>
  fetch(`http://${host}:${port}/health`, { proxy: null, signal: AbortSignal.timeout(2000) });

test.each([undefined, '0.0.0.0'])('production listener with HOST=%s', async (HOST) => {
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
    expect(await local.json()).toEqual({ status: 'ok' });
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
