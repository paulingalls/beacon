import { expect, test } from 'bun:test';
import { networkInterfaces } from 'node:os';

const address = Object.values(networkInterfaces())
  .flat()
  .find((item) => item?.family === 'IPv4' && !item.internal)?.address;

test('production listener defaults to loopback and permits an explicit public bind', async () => {
  if (!address) throw new Error('A non-loopback IPv4 interface is required');
  for (const host of [undefined, '0.0.0.0']) {
    const reservation = Bun.serve({ port: 0, fetch: () => new Response() });
    const chosenPort = reservation.port;
    await reservation.stop(true);
    const env: Record<string, string | undefined> = {
      ...process.env,
      PORT: String(chosenPort),
      DATABASE_URL: 'postgres://stub:stub@127.0.0.1:1/stub',
    };
    delete env.HOST;
    if (host) env.HOST = host;
    const child = Bun.spawn([process.execPath, 'apps/server/src/server.ts'], {
      env,
      stdout: 'pipe',
      stderr: 'inherit',
    });
    try {
      const reader = child.stdout.getReader();
      const output = await Promise.race([
        reader.read(),
        Bun.sleep(5000).then(() => {
          throw new Error('Listener did not start');
        }),
      ]);
      const port = new TextDecoder().decode(output.value).match(/:(\d+)/)?.[1];
      if (!port || port === '0') throw new Error('Startup must report the actual listening port');
      const local = await fetch(`http://127.0.0.1:${port}/health`, {
        proxy: null,
        signal: AbortSignal.timeout(2000),
      });
      expect(local.status).toBe(200);
      expect(await local.json()).toEqual({ status: 'ok' });
      const remote = fetch(`http://${address}:${port}/health`, {
        proxy: null,
        signal: AbortSignal.timeout(2000),
      });
      if (host) expect((await remote).status).toBe(200);
      else await expect(remote).rejects.toMatchObject({ code: 'ConnectionRefused' });
    } finally {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      await child.exited;
      clearTimeout(timer);
    }
  }
}, 15000);
