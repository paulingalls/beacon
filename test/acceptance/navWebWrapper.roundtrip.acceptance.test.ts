import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// The assembled SDK imported BY PACKAGE NAME — exercises the exports map (core + ./web subpath)
// and the whole client, exactly as test/acceptance/visitorIdentity.roundtrip.acceptance.test.ts does.
import { BeaconClient } from '@pi-innovations/beacon-client';
import { type NavBindings, useBeaconNav } from '@pi-innovations/beacon-client/web';
import { Hono } from 'hono';
import { createBeacon } from '../../apps/server/src/createBeacon';
// Live-DB setup via the server's own internals by relative path, as the sibling acceptance suites do.
import { closeDb, createDb } from '../../apps/server/src/storage/db';
import { runMigrations } from '../../apps/server/src/storage/migrate';
import { registerDbCoverageGuard, TEST_DB } from '../../apps/server/test/dbGuard';

// story-002 CAPSTONE (Milestone 6): the nav wrapper's History-API capture is exercised end to end
// by a REAL beacon-client driven by useBeaconNav, over a REAL ingest, then read back through the
// QUERY API (GET {basePath}/events) — the agent/dashboard-facing read path. The unit suite proved
// emission against a fake fetch; this proves the page_views actually land in Postgres with the
// shared anonymous visitor handle and that a same-path navigation does not double-count to the DB.

const PRODUCT = 'nav-roundtrip';
const WINDOW = 'after=2020-01-01T00:00:00Z&before=2030-01-01T00:00:00Z';

registerDbCoverageGuard();

/**
 * Inline fake History-API bindings (testkit isn't reachable by package name). A mutable pathname
 * driven by pushState/replaceState (the path arg mimics location.pathname after the real History
 * API updates synchronously), an external setPath + firePopState to simulate browser back/forward,
 * and a window listener map. Seed initialPath BEFORE useBeaconNav so the landing page_view is right.
 */
function makeNav(initialPath: string) {
  let pathname = initialPath;
  const winListeners = new Map<string, () => void>();
  const setPathFromUrl = (url?: string | null) => {
    // Mimic real location.pathname: strip query + hash so a query-string-only nav keeps the path.
    if (typeof url === 'string') pathname = url.split(/[?#]/)[0] ?? url;
  };
  const nav: NavBindings = {
    history: {
      pushState: (_data, _unused, url) => setPathFromUrl(url),
      replaceState: (_data, _unused, url) => setPathFromUrl(url),
    },
    get location() {
      return { pathname };
    },
    window: {
      addEventListener: (type, listener) => {
        winListeners.set(type, listener);
      },
      removeEventListener: (type) => {
        winListeners.delete(type);
      },
    },
  };
  return {
    nav,
    /** Navigate via the (possibly wrapped) live history method. */
    push: (path: string) => nav.history.pushState(null, '', path),
    /** Simulate browser back/forward: location is already updated when popstate fires. */
    setPath: (p: string) => {
      pathname = p;
    },
    firePopState: () => winListeners.get('popstate')?.(),
  };
}

describe.skipIf(!TEST_DB)('capstone — nav page_view round-trip (client → ingest → query)', () => {
  let sql: ReturnType<typeof createDb>;
  let beacon: ReturnType<typeof createBeacon>;
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;

  /** GET a query endpoint over the network through the admin server. */
  function query(path: string): Promise<Response> {
    return fetch(`${baseUrl}${beacon.basePath}${path}`);
  }

  beforeAll(async () => {
    sql = createDb({ connectionString: TEST_DB as string });
    await sql`DROP TABLE IF EXISTS beacon_events, beacon_short_links, beacon_meta, beacon_migrations CASCADE`;
    await runMigrations(sql);

    // No getUserId: the cookie-free SPA visitor is anonymous. isAdmin lets the query API serve reads.
    beacon = createBeacon({
      productId: PRODUCT,
      postgres: { connectionString: TEST_DB as string },
      isAdmin: () => true,
      flushInterval: 60_000, // disable the server timer; the test drains via beacon.flush()
    });
    const app = new Hono();
    app.route(beacon.basePath, beacon.router()); // mounts BOTH the ingest and the query endpoints
    server = Bun.serve({ port: 0, fetch: app.fetch });
    baseUrl = `http://localhost:${server.port}`;
  }, 15_000);

  afterAll(async () => {
    server.stop(true);
    await beacon.shutdown();
    await sql`DROP TABLE IF EXISTS beacon_events, beacon_short_links, beacon_meta, beacon_migrations CASCADE`;
    await closeDb(sql);
  }, 15_000);

  test('E2E: useBeaconNav route changes land as page_views with the shared visitor handle', async () => {
    const client = new BeaconClient({
      endpoint: `${baseUrl}${beacon.basePath}/events`,
      productId: PRODUCT,
      appContext: { appVersion: '1.0.0', platform: 'web' },
      flushInterval: 60_000,
      visitorToken: 'visitor-nav-1',
    });
    const nav = makeNav('/home');
    const stop = useBeaconNav(client, nav.nav); // emits the landing page_view {/home}
    try {
      nav.push('/pricing'); // forward — emits page_view {/pricing}
      nav.push('/pricing'); // same path — deduped, no emit
      nav.setPath('/home'); // browser back updates location first…
      nav.firePopState(); // …then fires popstate — emits page_view {/home}

      // Send the device batch over the wire, then drain the server buffer to Postgres.
      await client.flush();
      await beacon.flush();

      // Read back through the QUERY API (not raw SQL) — the consumer/agent path.
      const res = await query(`/events?${WINDOW}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        events: Array<{
          event_type: string;
          visitor_token: string | null;
          user_id: string | null;
          properties: { path?: string };
        }>;
      };

      const pageViews = body.events.filter((e) => e.event_type === 'page_view');
      // Four nav actions (incl. the duplicate /pricing push) → 3 stored: dedup survives to the DB.
      expect(pageViews).toHaveLength(3);
      // Order-tolerant: the batch shares one timestamp, so assert the path multiset, not sequence.
      expect(pageViews.map((e) => e.properties.path).sort()).toEqual([
        '/home',
        '/home',
        '/pricing',
      ]);
      // The SPA's anonymous handle rides every event (nav + in-page track() share one token).
      expect(pageViews.every((e) => e.visitor_token === 'visitor-nav-1')).toBe(true);
      // Anonymous throughout — no getUserId on the server, no body user_id from the public client.
      expect(pageViews.every((e) => e.user_id === null)).toBe(true);
    } finally {
      stop();
      client.shutdown();
    }
  }, 15_000);
});
