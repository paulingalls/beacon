import { expect } from 'bun:test';
import { createHash, createHmac } from 'node:crypto';
import { Hono } from 'hono';
import { createBeacon } from '../../apps/server/src/createBeacon';
import { closeDb, createDb } from '../../apps/server/src/storage/db';
import { runMigrations } from '../../apps/server/src/storage/migrate';
import type { BeaconConfig } from '../../apps/server/src/types';
import { TEST_DB } from '../../apps/server/test/dbGuard';

export const IP = '198.51.100.9';
export const OTHER_IP = '203.0.113.7';
export const SECRET = 'ip-mode-secret';
export const SALTS = ['first-memory-only-salt-0123456789!', 'second-memory-only-salt-123456789'];
export const sha = (value: string) => createHash('sha256').update(value).digest('hex');
export const digest = (salt: string, value = IP) =>
  createHmac('sha256', salt).update(value).digest('hex');

export async function fixture(config: Partial<BeaconConfig> = {}) {
  const sql = createDb({ connectionString: TEST_DB as string });
  await sql`DROP TABLE IF EXISTS beacon_events, beacon_short_links, beacon_meta, beacon_migrations CASCADE`;
  await runMigrations(sql);
  let time = Date.parse('2026-10-02T23:59:59.999Z');
  let saltIndex = 0;
  const beacon = createBeacon(
    {
      productId: 'ip-mode',
      postgres: { connectionString: TEST_DB as string },
      flushInterval: 60000,
      trustedIngestToken: SECRET,
      isAdmin: (c) => c.req.header('authorization') === `Bearer ${SECRET}`,
      queryRateLimit: 2,
      shortLinkCreateRateLimit: 2,
      ...config,
    },
    {
      now: () => time,
      salt: () => Buffer.from(SALTS[saltIndex++] as string),
      schedule: () => () => {},
    },
  );
  const app = new Hono();
  app.get('/logged', beacon.middleware(), (c) => c.json({ token: beacon.getVisitorToken(c) }));
  app.get('/track', (c) => {
    beacon.track(c, 'direct_track');
    return c.text('ok');
  });
  app.route('/analytics', beacon.router());
  app.route('/', beacon.shortener());
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  const base = `http://localhost:${server.port}`;
  const request = (path: string, init: RequestInit = {}, ip = IP) =>
    fetch(`${base}${path}`, {
      ...init,
      redirect: 'manual',
      headers: { 'x-forwarded-for': ip, ...init.headers },
    });
  const post = (events: unknown[], trusted = false, ip = IP) =>
    request(
      '/analytics/events',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(trusted ? { authorization: `Bearer ${SECRET}` } : {}),
        },
        body: JSON.stringify({ events }),
      },
      ip,
    );
  const rows = async () => {
    await beacon.flush();
    return sql<
      { event_type: string; context: { ip?: string } }[]
    >`SELECT event_type, context FROM beacon_events ORDER BY timestamp, received_at, event_id`;
  };
  const walk = async () => {
    expect((await request('/logged')).status).toBe(200);
    expect((await request('/track')).status).toBe(200);
    expect((await post([{ event_type: 'untrusted', context: { ip: 'spoof' } }])).status).toBe(202);
    expect((await post([{ event_type: 'trusted', context: { ip: IP } }], true)).status).toBe(202);
    const link = await beacon.createShortLink({
      destination: 'https://example.com',
      productId: 'ip-mode',
    });
    expect((await request(`/${link.code}`)).status).toBe(302);
  };
  return {
    sql,
    beacon,
    base,
    request,
    post,
    rows,
    walk,
    midnight: () => {
      time += 1;
    },
    close: async () => {
      server.stop(true);
      await beacon.shutdown();
      await closeDb(sql);
    },
  };
}
