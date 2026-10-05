import { Hono } from 'hono';
import { createBeacon } from '../../../apps/server/src/createBeacon';

import '../../setup/ensure-test-db';
import { closeDb, createDb } from '../../../apps/server/src/storage/db';
import { runMigrations } from '../../../apps/server/src/storage/migrate';

const TEST_DB = process.env.TEST_DATABASE_URL;
if (!TEST_DB) {
  console.error(
    '[dashboard-e2e] TEST_DATABASE_URL is unset after bootstrap — start docker Postgres ' +
      '(`docker compose up -d postgres`) before running the dashboard e2e. Refusing to serve ' +
      'an unseeded dashboard.',
  );
  process.exit(1);
}

const ADMIN_PORT = Number(process.env.ADMIN_PORT ?? 3917);
const DENY_PORT = Number(process.env.DENY_PORT ?? 3918);

const DAY = 86_400_000;
const base = Date.now() - 10 * DAY;
const at = (offsetMs: number) => new Date(base + offsetMs);

const ev = (
  product_id: string,
  event_type: string,
  timestamp: Date,
  user_id: string | null,
  visitor_token: string | null,
  properties: Record<string, unknown>,
  attribution: Record<string, unknown>,
) => ({
  product_id,
  event_type,
  timestamp,
  user_id,
  visitor_token,
  properties,
  attribution,
});

const SEED = [
  ev('clipcast', 'request', at(0), 'u1', null, { path: '/home' }, { utm_source: 'google' }),
  ev('clipcast', 'signup', at(3_600_000), 'u1', null, {}, {}),
  ev('clipcast', 'request', at(0), 'u2', null, { path: '/pricing' }, { utm_source: 'google' }),
  ev('clipcast', 'signup', at(1_800_000), 'u2', null, {}, {}),
  ev('clipcast', 'request', at(0), null, 'v3', { path: '/home' }, { utm_source: 'twitter' }),
  ev('clipcast', 'request', at(0), null, 'v4', { path: '/home' }, { utm_source: 'twitter' }),
  ev('clipcast', 'request', at(0), 'u5', null, { path: '/pricing' }, { utm_source: 'google' }),
  ev('lensflare', 'request', at(0), 'u6', null, { path: '/dash' }, { utm_source: 'bing' }),
  ev('lensflare', 'signup', at(900_000), 'u6', null, {}, {}),
  ev('lensflare', 'request', at(0), null, 'v7', { path: '/dash' }, { utm_source: 'bing' }),
];

for (const e of SEED.filter((e) => e.event_type === 'request')) {
  e.attribution.utm_medium = e.attribution.utm_source === 'twitter' ? 'social' : 'search';
  e.attribution.utm_campaign = `${e.product_id}-launch`;
}
for (const [i, timestamp] of [
  '2024-03-10T07:59:59Z',
  '2024-03-10T08:00:00Z',
  '2024-03-11T06:59:59Z',
  '2024-03-11T07:00:00Z',
].entries()) {
  SEED.push(
    ev(
      'calendar',
      'request',
      new Date(timestamp),
      `calendar-${i}`,
      null,
      { path: i === 0 ? '/before-day' : i === 3 ? '/after-day' : '/inside-day' },
      {},
    ),
  );
}

const sql = createDb({ connectionString: TEST_DB });
await sql`DROP TABLE IF EXISTS beacon_events, beacon_short_links, beacon_meta, beacon_migrations CASCADE`;
await runMigrations(sql);

type JsonInput = Parameters<typeof sql.json>[0];
const eventRows = SEED.map((e) => ({
  ...e,
  platform: 'web',
  properties: sql.json(e.properties as JsonInput),
  context: sql.json({} as JsonInput),
  attribution: sql.json(e.attribution as JsonInput),
}));
await sql`INSERT INTO beacon_events ${sql(eventRows)}`;

const metaCounts = new Map<string, number>();
for (const e of SEED) {
  const key = `${e.product_id}::${e.event_type}`;
  metaCounts.set(key, (metaCounts.get(key) ?? 0) + 1);
}
const metaRows = [...metaCounts].map(([key, count]) => {
  const [product_id, event_type] = key.split('::');
  return { product_id, event_type, count };
});
await sql`INSERT INTO beacon_meta ${sql(metaRows, 'product_id', 'event_type', 'count')}`;
await closeDb(sql);

function serve(port: number, isAdmin: boolean, basePath = '/analytics') {
  const beacon = createBeacon({
    productId: 'dashboard-e2e',
    basePath,
    postgres: { connectionString: TEST_DB as string },
    isAdmin: () => isAdmin,
    getUserId: () => null,
    flushInterval: 60_000,
    // All browser clients share the loopback rate-limit key.
    queryRateLimit: 100_000,
  });
  const app = new Hono();
  // Exclude capture: dashboard requests must not inflate the seeded totals.
  app.route(beacon.basePath, beacon.router());
  return Bun.serve({ port, fetch: app.fetch });
}

serve(ADMIN_PORT, true);
serve(DENY_PORT, false);
serve(3919, true, '/custom/analytics');
console.log(
  `[dashboard-e2e] admin on :${ADMIN_PORT}, deny on :${DENY_PORT} — seeded ${SEED.length} events`,
);
