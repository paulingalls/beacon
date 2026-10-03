import { expect } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ContainerFixture, docker, ingest, until } from './container.fixture';
import { gatewayHealth, health, inspect, persisted, query, red } from './container.guards';
import { serverMutation } from './container.trace';

export async function scenario(work: (f: ContainerFixture) => Promise<void>) {
  const f = new ContainerFixture();
  try {
    await f.setup();
    await f.step('migrate');
    await work(f);
  } finally {
    await f.cleanup();
  }
}
export async function workload(f: ContainerFixture, url: string, marker: string) {
  await f.ready(url);
  await gatewayHealth(url);
  await ingest(url, marker);
  await until(
    'SQL event persistence',
    async () =>
      (await f.sql(`SELECT count(*) FROM beacon_events WHERE event_type='${marker}'`)) === '1',
  );
  await persisted(f, marker);
  await query(url, marker);
}
export async function shutdown(
  f: ContainerFixture,
  url: string,
  options: string[] = [],
  timed = true,
) {
  await f.reset();
  const start = Date.now();
  await f.launch(options);
  await f.ready(url);
  const marker = `shutdown-${crypto.randomUUID()}`;
  await ingest(url, marker);
  const count = await f.sql(`SELECT count(*) FROM beacon_events WHERE event_type='${marker}'`);
  const checked = Date.now();
  expect(count).toBe('0');
  if (timed) expect(checked - start).toBeLessThan(5000);
  const stopping = Date.now();
  expect(stopping - checked).toBeLessThan(100);
  await f.stop();
  await persisted(f, marker);
  return marker;
}
export function delayFlush(f: ContainerFixture) {
  return f.preload(`const original = globalThis.setInterval;
    globalThis.setInterval = ((callback, ms, ...args) => original(callback, ms === 5000 ? 60000 : ms, ...args));`);
}
export async function policy(f: ContainerFixture, url: string, marker: string) {
  await workload(f, url, marker);
  const context = JSON.parse(
    await f.sql(`SELECT context FROM beacon_events WHERE event_type='${marker}'`),
  );
  expect(context.ip).toBeUndefined();
  expect(context.referrer).toBe('https://example.com/path');
}
export async function retention(
  f: ContainerFixture,
  url: string,
  days: string | undefined,
  overbroad = false,
) {
  await f.reset();
  await f.sql('TRUNCATE beacon_events');
  await f.sql(
    "INSERT INTO beacon_events (product_id,event_type,timestamp) VALUES ('container','old',now()-interval '2 days'), ('container','young',now()-interval '12 hours')",
  );
  f.envFile({ RETENTION_DAYS: days });
  const preload = f.preload(`const original = globalThis.setInterval;
    globalThis.setInterval = ((callback, ms, ...args) => {
      if (ms === 86400000) console.log('diagnostic retention timer');
      return original(callback, ms === 86400000 ? 100 : ms, ...args);
    });`);
  const options = overbroad
    ? [
        ...preload,
        ...serverMutation(
          f,
          'retentionDays: parseRetentionDays(env.RETENTION_DAYS)',
          'retentionDays: 0.01',
        ),
      ]
    : preload;
  await f.launch(options);
  await f.ready(url);
  if (days && days !== '0') {
    await until(
      'old event pruned',
      async () =>
        (await f.sql("SELECT count(*) FROM beacon_events WHERE event_type='old'")) === '0',
      3000,
    );
    expect(await docker('logs', f.env.SERVER as string)).toContain('diagnostic retention timer');
    expect(await f.sql("SELECT count(*) FROM beacon_events WHERE event_type='young'")).toBe('1');
  } else {
    await Bun.sleep(500);
    expect(await f.sql('SELECT count(*) FROM beacon_events')).toBe('2');
    expect(await docker('logs', f.env.SERVER as string)).not.toContain(
      'diagnostic retention timer',
    );
  }
  await workload(f, url, `retention-${days ?? 'unset'}`);
}
export async function dbFreeHealth(f: ContainerFixture, url: string) {
  await health(f);
  expect(
    (await fetch(`${url}/analytics/events`, { headers: { authorization: 'Bearer fixture-admin' } }))
      .status,
  ).toBe(200);
  await docker('stop', f.env.PG as string);
  try {
    try {
      const response = await fetch(`${url}/analytics/events`, {
        headers: { authorization: 'Bearer fixture-admin' },
        signal: AbortSignal.timeout(15000),
      });
      expect([500, 502, 504]).toContain(response.status);
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== 'TimeoutError') throw error;
    }
    const before = (await inspect(f.env.SERVER as string)).State.Health.Log.at(-1).Start;
    expect(
      await (await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) })).json(),
    ).toEqual({ status: 'ok' });
    await until(
      'fresh DB-free Docker health success',
      async () => {
        const entry = (await inspect(f.env.SERVER as string)).State.Health.Log.at(-1);
        return entry.Start > before && entry.ExitCode === 0;
      },
      15000,
    );
  } finally {
    await docker('start', f.env.PG as string);
  }
}
export async function externalProbe(f: ContainerFixture, allow = false) {
  const name = `${f.id}-canary`;
  if (!f.containers.has(name)) {
    f.containers.add(name);
    await docker(
      'run',
      '-d',
      '--name',
      name,
      '--network',
      f.env.PUBLIC_NETWORK as string,
      f.env.IMAGE as string,
      'bun',
      '-e',
      "Bun.serve({port:9000,fetch:()=>new Response('canary')});",
    );
  }
  const canary = await inspect(name);
  const ip = canary.NetworkSettings.Networks[f.env.PUBLIC_NETWORK as string].IPAddress;
  const script = `try {const r=await fetch('http://${ip}:9000',{signal:AbortSignal.timeout(1500)}); if(await r.text()!=='canary')process.exit(4);console.log('reachable')}catch(e){if(!['TimeoutError','AbortError'].includes(e.name)&&!['ECONNREFUSED','ENETUNREACH','EHOSTUNREACH','ETIMEDOUT','FailedToOpenSocket'].includes(e.code))throw e;console.log('blocked')}`;
  expect(
    await docker(
      'run',
      '--rm',
      '--network',
      f.env.PUBLIC_NETWORK as string,
      f.env.IMAGE as string,
      'bun',
      '-e',
      script,
    ),
  ).toBe('reachable');
  if (allow)
    await docker('network', 'connect', f.env.PUBLIC_NETWORK as string, f.env.SERVER as string);
  try {
    const output = await docker('exec', f.env.SERVER as string, 'bun', '-e', script);
    expect(output).toBe('blocked');
  } finally {
    if (allow)
      await docker('network', 'disconnect', f.env.PUBLIC_NETWORK as string, f.env.SERVER as string);
  }
}
export function updateCaddy(f: ContainerFixture, wrong: boolean) {
  const path = join(f.dir, 'Caddyfile');
  const source = readFileSync(path, 'utf8');
  writeFileSync(
    path,
    source.replace(
      wrong ? `beacon:${f.env.PORT}` : 'beacon:1',
      wrong ? 'beacon:1' : `beacon:${f.env.PORT}`,
    ),
  );
}

export async function healthControls(f: ContainerFixture) {
  const url = await f.gateway();
  await f.launch();
  await f.ready(url);
  await dbFreeHealth(f, url);
  for (const [fault, options] of [
    ['missing-healthcheck', ['--no-healthcheck']],
    [
      'bad-health-path',
      [
        '--health-cmd',
        'bun -e \'const r=await fetch("http://127.0.0.1:"+process.env.PORT+"/missing-health");if(!r.ok)process.exit(1)\'',
      ],
    ],
    [
      'hardcoded-health-port',
      ['--health-cmd', 'bun -e \'await fetch("http://127.0.0.1:8080/health")\''],
    ],
  ] as const) {
    await f.reset();
    await f.launch([...options]);
    await f.ready(url);
    await red(
      fault,
      async () => {
        await Bun.sleep(5500);
        expect((await inspect(f.env.SERVER as string)).State.Health?.Status).toBe('healthy');
      },
      /toBe/,
    );
  }
  await f.reset();
  await f.launch(
    serverMutation(
      f,
      "app.get('/health', (c) => c.json({ status: 'ok' }));",
      "app.get('/health', async (c) => { try { await beacon.createShortLink({destination:'https://example.com',productId:'container'}); return c.json({status:'ok'}); } catch { return c.json({status:'db unavailable'},500); } });",
    ),
  );
  await f.ready(url);
  await red('health-needs-db', () => dbFreeHealth(f, url), /toEqual|toBe|timed out|Timeout/);
}
