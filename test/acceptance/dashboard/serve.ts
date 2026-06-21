// Playwright webServer entry for the dashboard browser-UI acceptance surface (story-006).
// Runs under Bun (Playwright spawns it as `bun .../serve.ts`), OUTSIDE the root bunfig DB
// preload — so it bootstraps Postgres itself, seeds a known dataset, and serves the mounted
// Beacon app on fixed ports. The companion specs (dashboard.e2e.ts) drive a real browser
// against ADMIN_PORT and assert the rendered widgets.
//
// Seeded ~10 days ago: inside the dashboard's default 30-day window but outside the 7d/today
// presets, so the same fixture exercises both populated and empty states.

import { Hono } from 'hono';
import { createBeacon } from '../../../apps/server/src/createBeacon';

// Side-effect import: ensure-test-db starts docker Postgres and sets TEST_DATABASE_URL when
// unset (idempotent). Its own posture is skip-gracefully; we override that to FAIL LOUD
// below, because a webServer that came up against no DB would render empty widgets and let
// the e2e pass vacuously (concern f3ce91828b59 / the DB-coverage-guard constraint).
import '../../setup/ensure-test-db';
import { closeDb, createDb } from '../../../packages/beacon/src/storage/db';
import { runMigrations } from '../../../packages/beacon/src/storage/migrate';

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

interface SeedEvent {
  product_id: string;
  event_type: string;
  timestamp: Date;
  user_id: string | null;
  visitor_token: string | null;
  properties: Record<string, unknown>;
  attribution: Record<string, unknown>;
}

const ev = (
  product_id: string,
  event_type: string,
  timestamp: Date,
  user_id: string | null,
  visitor_token: string | null,
  properties: Record<string, unknown>,
  attribution: Record<string, unknown>,
): SeedEvent => ({
  product_id,
  event_type,
  timestamp,
  user_id,
  visitor_token,
  properties,
  attribution,
});

// clipcast: 5 requests (3 google, 2 twitter) + 2 signups (u1, u2) → count 7, users 3,
// visitors 5; top /home=3 /pricing=2; attribution google clicks 3 conv 2, twitter clicks 2
// conv 0; funnel request 5 → signup 2. lensflare gives the product selector a distinct switch.
const SEED: SeedEvent[] = [
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

const sql = createDb({ connectionString: TEST_DB });
await sql`DROP TABLE IF EXISTS beacon_events, beacon_short_links, beacon_meta, beacon_migrations CASCADE`;
await runMigrations(sql);

// Mirrors events/buffer.ts: the sql.json() param type is narrower than Record<string, unknown>.
type JsonInput = Parameters<typeof sql.json>[0];
const eventRows = SEED.map((e) => ({
  product_id: e.product_id,
  event_type: e.event_type,
  timestamp: e.timestamp,
  user_id: e.user_id,
  visitor_token: e.visitor_token,
  platform: 'web',
  properties: sql.json(e.properties as JsonInput),
  context: sql.json({} as JsonInput),
  attribution: sql.json(e.attribution as JsonInput),
}));
await sql`INSERT INTO beacon_events ${sql(eventRows)}`;

// beacon_meta drives GET /schema (products + event types) the dashboard's selector and funnel
// default read; seed it from the same fixture so the production read path has data.
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

/** Mount the Beacon router (dashboard + query API) gated by the given admin verdict. */
function serve(port: number, isAdmin: boolean) {
  const beacon = createBeacon({
    productId: 'dashboard-e2e',
    postgres: { connectionString: TEST_DB as string },
    isAdmin: () => isAdmin,
    getUserId: () => null,
    flushInterval: 60_000,
    // getUserId returns null, so every query request keys the rate limiter on the
    // single loopback IP — the whole browser suite shares one 60s bucket. The default
    // 60/60s cap leaves only ~15 headroom over the suite's ~45 query GETs, so a retry
    // or a slow render wave can 429 a widget into .beacon-error and flake an assertion.
    // Lift the cap out of the way: the harness is not testing the production limiter.
    queryRateLimit: 100_000,
  });
  const app = new Hono();
  // Router only (no request-logging middleware): the widgets count seeded events, and the
  // middleware would log each query GET as its own 'request' event, inflating the totals.
  app.route(beacon.basePath, beacon.router());
  return Bun.serve({ port, fetch: app.fetch });
}

serve(ADMIN_PORT, true);
serve(DENY_PORT, false);
console.log(
  `[dashboard-e2e] admin on :${ADMIN_PORT}, deny on :${DENY_PORT} — seeded ${SEED.length} events`,
);
