import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { block, ContainerFixture, docker, ingest, runbook, until } from './container.fixture';

const fixture = new ContainerFixture();
beforeAll(() => fixture.setup(), 180000);
afterAll(() => fixture.cleanup(), 60000);

test('container documented launch', () => {
  for (const step of [
    'build',
    'network',
    'postgres',
    'address',
    'env',
    'migrate',
    'launch',
    'caddy-config',
    'caddy-launch',
    'stop',
  ]) {
    expect(block(step).length).toBeGreaterThan(0);
    expect(() => block(step, runbook.replace(`<!-- container-${step} -->`, ''))).toThrow();
  }
});
test('container health definition', () => {
  expect(readFileSync('Dockerfile', 'utf8')).toContain('HEALTHCHECK');
});
test('container migration', async () => {
  await fixture.step('migrate');
  const ledger = await fixture.sql('SELECT filename FROM beacon_migrations ORDER BY filename');
  expect(ledger.split('\n').length).toBeGreaterThan(0);
  expect(
    await fixture.sql(
      "SELECT count(*) FROM pg_tables WHERE tablename IN ('beacon_events','beacon_meta','beacon_short_links','beacon_erasures')",
    ),
  ).toBe('4');
  await fixture.step('migrate');
  expect(await fixture.sql('SELECT filename FROM beacon_migrations ORDER BY filename')).toBe(
    ledger,
  );
}, 60000);
test('container shutdown drain and authenticated persistence', async () => {
  const start = Date.now();
  const url = await fixture.launch();
  const marker = 'shutdown';
  await ingest(url, marker);
  expect(await fixture.sql(`SELECT count(*) FROM beacon_events WHERE event_type='${marker}'`)).toBe(
    '0',
  );
  expect(Date.now() - start).toBeLessThan(5000);
  await fixture.stop();
  expect(
    await fixture.sql(
      `SELECT count(*) FROM beacon_events WHERE event_type='${marker}' AND user_id='container-user'`,
    ),
  ).toBe('1');
  const restarted = await fixture.launch(`${fixture.id}-restart`);
  expect((await fetch(`${restarted}/analytics/events`)).status).toBe(403);
  expect((await fetch(`${restarted}/analytics/dashboard`)).status).toBe(403);
  const query = await fetch(`${restarted}/analytics/events?product_id=container`, {
    headers: { authorization: 'Bearer fixture-admin' },
  });
  expect(query.status).toBe(200);
  expect(await query.text()).toContain(marker);
  await fixture.stop(`${fixture.id}-restart`);
}, 60000);
test('container policy wiring', async () => {
  const context = JSON.parse(
    await fixture.sql("SELECT context FROM beacon_events WHERE event_type='shutdown'"),
  );
  expect(context.ip).toBeUndefined();
  expect(context.referrer).toBe('https://example.com/path');
});
test('container caddy proxy and DB-free health', async () => {
  const name = `${fixture.id}-proxy-app`;
  const url = await fixture.launch(name);
  // The documented upstream alias belongs to the ordinary launch.
  await docker('network', 'disconnect', fixture.env.NETWORK as string, name);
  await docker('network', 'connect', '--alias', 'beacon', fixture.env.NETWORK as string, name);
  fixture.containers.add(fixture.env.CADDY as string);
  await fixture.step('caddy-config');
  await fixture.step('caddy-launch');
  const proxy = `http://${await docker('port', fixture.env.CADDY as string, '80/tcp')}`;
  await until('Caddy upstream', async () => {
    try {
      return (await fetch(`${proxy}/health`)).ok;
    } catch {
      return false;
    }
  });
  await ingest(proxy, 'caddy');
  await until(
    'Caddy SQL persistence',
    async () =>
      (await fixture.sql("SELECT count(*) FROM beacon_events WHERE event_type='caddy'")).trim() ===
      '1',
  );
  expect((await fetch(`${proxy}/analytics/events`)).status).toBe(403);
  expect(
    (
      await fetch(`${proxy}/analytics/events?product_id=container`, {
        headers: { authorization: 'Bearer fixture-admin' },
      })
    ).status,
  ).toBe(200);
  await until(
    'Docker health healthy',
    async () =>
      (await docker('inspect', '--format', '{{.State.Health.Status}}', name)) === 'healthy',
  );
  await docker('stop', fixture.env.PG as string);
  try {
    expect(
      (
        await fetch(`${url}/analytics/events?product_id=container`, {
          headers: { authorization: 'Bearer fixture-admin' },
        })
      ).status,
    ).toBe(500);
    expect(await (await fetch(`${url}/health`)).json()).toEqual({ status: 'ok' });
    await Bun.sleep(5500);
    expect(await docker('inspect', '--format', '{{.State.Health.Status}}', name)).toBe('healthy');
  } finally {
    await docker('start', fixture.env.PG as string);
  }
  await fixture.stop(name);
}, 90000);
