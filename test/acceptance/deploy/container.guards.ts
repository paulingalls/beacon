import { expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { block, type ContainerFixture, docker, root, runbook, until } from './container.fixture';

export function launchTopology(source = runbook) {
  expect(block('launch', source)).not.toMatch(/\s-p\s/);
  expect(block('caddy-launch', source)).toContain('--network "$PUBLIC_NETWORK"');
  expect(block('caddy-launch', source)).toContain('docker network connect "$NETWORK"');
}
export const guidance = [
  'IP_MODE=none',
  'REFERRER_MODE=origin-and-path',
  'RETENTION_DAYS=30',
  'Re-resolve',
  'hostname-only',
  'browser-side',
  'cdn.jsdelivr.net/npm/chart.js',
  'failed/swallowed',
  '0.0.0.0:65535',
  '[::]:65535',
  'Postgres-IP:0',
  'no send',
  'missing Docker/tracing',
  'reader-role',
  'DATABASE_URL',
];
export function documentation(source: string) {
  launchTopology(source);
  for (const word of guidance) expect(source).toContain(word);
}
export async function inspect(name: string) {
  return JSON.parse(await docker('inspect', name))[0];
}
export async function isolated(f: ContainerFixture) {
  for (const name of [f.env.SERVER, f.env.PG]) {
    const config = await inspect(name as string);
    expect(Object.keys(config.NetworkSettings.Networks)).toEqual([f.env.NETWORK as string]);
    expect(Object.values(config.NetworkSettings.Ports).every((value) => value === null)).toBe(true);
    expect(Object.keys(config.HostConfig.PortBindings ?? {})).toEqual([]);
  }
  const gateway = await inspect(f.env.CADDY as string);
  expect(gateway.HostConfig.NetworkMode).toBe(f.env.PUBLIC_NETWORK);
  expect(Object.keys(gateway.NetworkSettings.Networks).sort()).toEqual(
    [f.env.NETWORK, f.env.PUBLIC_NETWORK].sort(),
  );
  expect(
    await docker('network', 'inspect', '--format', '{{.Internal}}', f.env.NETWORK as string),
  ).toBe('true');
  expect(
    await docker('network', 'inspect', '--format', '{{.Internal}}', f.env.PUBLIC_NETWORK as string),
  ).toBe('false');
}
export async function persisted(f: ContainerFixture, marker: string) {
  expect(
    await f.sql(
      `SELECT count(*) FROM beacon_events WHERE event_type='${marker}' AND user_id='container-user'`,
    ),
  ).toBe('1');
}
export async function query(url: string, marker: string) {
  for (const path of ['events', 'dashboard']) {
    expect((await fetch(`${url}/analytics/${path}`)).status).toBe(403);
  }
  const response = await fetch(`${url}/analytics/events?product_id=container`, {
    headers: { authorization: 'Bearer fixture-admin' },
    signal: AbortSignal.timeout(15000),
  });
  expect(response.status).toBe(200);
  expect(await response.text()).toContain(marker);
}
export async function health(f: ContainerFixture) {
  await until(
    'Docker healthy',
    async () => (await inspect(f.env.SERVER as string)).State.Health?.Status === 'healthy',
  );
}
export async function parity(
  f: ContainerFixture,
  ordinary: { env: string[]; source: string; cmd: string[]; image: string },
) {
  const actual = await inspect(f.env.SERVER as string);
  expect(actual.Image).toBe(ordinary.image);
  expect(actual.Config.Env).toEqual(ordinary.env);
  expect(actual.Config.Cmd.slice(-ordinary.cmd.length)).toEqual(ordinary.cmd);
  expect(
    await docker('exec', f.env.SERVER as string, 'sha256sum', '/app/apps/server/src/server.ts'),
  ).toBe(ordinary.source);
}
export async function ordinaryEvidence(f: ContainerFixture) {
  const actual = await inspect(f.env.SERVER as string);
  expect(actual.Config.Cmd).toEqual(['bun', 'run', 'apps/server/src/server.ts']);
  const source = await docker(
    'exec',
    f.env.SERVER as string,
    'sha256sum',
    '/app/apps/server/src/server.ts',
  );
  const local = new Bun.CryptoHasher('sha256')
    .update(readFileSync(`${root}/apps/server/src/server.ts`))
    .digest('hex');
  expect(source.split(' ')[0]).toBe(local);
  return {
    env: actual.Config.Env as string[],
    source,
    cmd: actual.Config.Cmd as string[],
    image: actual.Image as string,
  };
}

export async function red(name: string, action: () => Promise<unknown>, target: RegExp) {
  if (Bun.env.BEACON_CONTAINER_FAULT === name) {
    await action();
    return;
  }
  await expect(action()).rejects.toThrow(target);
  console.log(`observed red: ${name}`);
}

export async function gatewayHealth(url: string) {
  const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: 'ok' });
}
