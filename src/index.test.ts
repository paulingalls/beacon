import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { registerDbCoverageGuard, TEST_DB } from '../test/dbGuard';

import { ctxWith, withTestDb } from '../test/helpers';
import { type BeaconConfig, createBeacon, createHttpBeacon, verifyTrustedBearer } from './index';

registerDbCoverageGuard();

describe('public API exports', () => {
  test('re-exports verifyTrustedBearer for host reuse', () => {
    expect(typeof verifyTrustedBearer).toBe('function');
    expect(verifyTrustedBearer('Bearer s3cret', 's3cret')).toBe(true);
    expect(verifyTrustedBearer('Bearer wrong', 's3cret')).toBe(false);
    expect(verifyTrustedBearer('Bearer s3cret', undefined)).toBe(false); // fail-closed
  });

  test('re-exports createHttpBeacon (framework-agnostic factory, Milestone 3)', async () => {
    expect(typeof createHttpBeacon).toBe('function');
    // Smoke: constructs without a DB (HTTP single-writer — no postgres) and exposes
    // the capture/track/flush/shutdown surface.
    const b = createHttpBeacon({
      productId: 'p',
      endpoint: 'https://beacon.example/analytics/events',
      trustedIngestToken: 't',
      fetch: (async () => new Response(null, { status: 202 })) as unknown as typeof fetch,
    });
    expect(typeof b.capture).toBe('function');
    expect(typeof b.track).toBe('function');
    expect(typeof b.flush).toBe('function');
    expect(typeof b.shutdown).toBe('function');
    await b.shutdown(); // clear the flush timer
  });
});

const baseConfig = (overrides: Partial<BeaconConfig> = {}): BeaconConfig => ({
  productId: 'beacon-test',
  postgres: { connectionString: 'postgres://u:p@127.0.0.1:1/db' },
  ...overrides,
});

describe('createBeacon (unit)', () => {
  test('throws when productId is missing', () => {
    expect(() =>
      createBeacon({ productId: '', postgres: { connectionString: 'postgres://x' } }),
    ).toThrow(/productId/);
  });

  test('throws when postgres.connectionString is missing', () => {
    // biome-ignore lint/suspicious/noExplicitAny: testing a misconfig the types forbid
    expect(() => createBeacon({ productId: 'p', postgres: {} } as any)).toThrow(/connectionString/);
  });

  test('throws when productAllowlist is set but does not include productId', () => {
    // The absent->configured-default fallback target must itself be allowlisted,
    // else absent-product_id events would leak a non-allowlisted product (story-006).
    expect(() =>
      createBeacon(baseConfig({ productId: 'host', productAllowlist: ['other-app'] })),
    ).toThrow(/productAllowlist/);
  });

  test('constructs when productAllowlist includes productId', () => {
    const beacon = createBeacon(
      baseConfig({ productId: 'host', productAllowlist: ['host', 'other-app'] }),
    );
    expect(typeof beacon.router).toBe('function');
  });

  test('returns the documented surface, starts the buffer empty, and never throws at construction even with unreachable Postgres (§1.3)', () => {
    // baseConfig points at an unreachable host; createDb never throws, so the
    // factory must construct cleanly without a connectivity gate.
    const beacon = createBeacon(baseConfig());
    expect(beacon.basePath).toBe('/analytics');
    expect(typeof beacon.middleware).toBe('function');
    expect(typeof beacon.track).toBe('function');
    expect(typeof beacon.router).toBe('function');
    expect(typeof beacon.stats).toBe('function');
    expect(typeof beacon.flush).toBe('function');
    expect(typeof beacon.shutdown).toBe('function');
    expect(typeof beacon.getVisitorToken).toBe('function');
    expect(typeof beacon.appendToken).toBe('function');
    expect(typeof beacon.associateVisitor).toBe('function');
    expect(typeof beacon.shortener).toBe('function');
    expect(typeof beacon.createShortLink).toBe('function');
    expect(beacon.stats().buffered).toBe(0);
    // Fire-and-forget cleanup: shutdown() clears the flush timer synchronously
    // (buffer.stop) so no timer leaks; the unreachable closeDb drains in the
    // background. The .catch() prevents an unhandled rejection if sql.end()
    // rejects on the unreachable host. The reachable shutdown path is asserted
    // in the integration suite, where closeDb returns promptly.
    void beacon.shutdown().catch(() => {});
  });

  test('getVisitorToken returns the context token, or null when absent', () => {
    const beacon = createBeacon(baseConfig());
    expect(beacon.getVisitorToken(ctxWith('tok123456789'))).toBe('tok123456789');
    expect(beacon.getVisitorToken(ctxWith(undefined))).toBeNull();
    void beacon.shutdown().catch(() => {});
  });

  test('appendToken appends _t with the right separator, preserves fragments, and no-ops without a token', () => {
    const beacon = createBeacon(baseConfig());
    const c = ctxWith('tok123456789');
    expect(beacon.appendToken('/dashboard', c)).toBe('/dashboard?_t=tok123456789');
    expect(beacon.appendToken('/dashboard?ref=1', c)).toBe('/dashboard?ref=1&_t=tok123456789');
    expect(beacon.appendToken('/dashboard#section', c)).toBe('/dashboard?_t=tok123456789#section');
    expect(beacon.appendToken('/dashboard?ref=1#x', c)).toBe('/dashboard?ref=1&_t=tok123456789#x');
    // No token in context → URL is returned unchanged.
    expect(beacon.appendToken('/dashboard', ctxWith(undefined))).toBe('/dashboard');
    // Idempotent: a URL already carrying _t is not double-appended (would split
    // the trail). Holds whether _t is the only param or one of several.
    expect(beacon.appendToken('/dashboard?_t=old', c)).toBe('/dashboard?_t=old');
    expect(beacon.appendToken('/dashboard?ref=1&_t=old#x', c)).toBe('/dashboard?ref=1&_t=old#x');
    void beacon.shutdown().catch(() => {});
  });

  test('associateVisitor with no token in context is a clean no-op (no SQL, no throw)', async () => {
    const beacon = createBeacon(baseConfig());
    await expect(beacon.associateVisitor(ctxWith(undefined), 'user-1')).resolves.toBeUndefined();
    void beacon.shutdown().catch(() => {});
  });

  test('associateVisitor never throws when Postgres is unreachable (§1.3)', async () => {
    // baseConfig is unreachable; the UPDATE rejects, associateVisitor catches it.
    const beacon = createBeacon(baseConfig());
    await expect(
      beacon.associateVisitor(ctxWith('tok123456789'), 'user-1'),
    ).resolves.toBeUndefined();
    void beacon.shutdown().catch(() => {});
  });
});

// Router wiring (§5.1/§5.2/§5.4) — auth + rate-limit behavior fires before any DB
// call, so these assert without Postgres. Admin reaching a handler 500s on the
// unreachable host (proving the route is mounted, not a 404); data correctness is
// covered by the per-endpoint integration suites + the over-network capstone.
describe('createBeacon router (query API mounting)', () => {
  const QUERY_ROUTES = ['/schema', '/events', '/aggregate', '/funnel', '/attribution'];

  /** Mount beacon.router() under basePath on a fresh app. */
  function mount(beacon: ReturnType<typeof createBeacon>): Hono {
    const app = new Hono();
    app.route(beacon.basePath, beacon.router());
    return app;
  }

  async function errCode(res: Response): Promise<string> {
    return ((await res.json()) as { error: { code: string } }).error.code;
  }

  test('a non-admin gets a §5.5 UNAUTHORIZED 403 on every query route', async () => {
    const beacon = createBeacon(baseConfig({ isAdmin: () => false }));
    const app = mount(beacon);
    for (const route of QUERY_ROUTES) {
      const res = await app.request(`/analytics${route}`);
      expect(res.status).toBe(403);
      expect(await errCode(res)).toBe('UNAUTHORIZED');
    }
    void beacon.shutdown().catch(() => {});
  });

  test('an admin passes the gate and reaches each handler (500 on the unreachable host, not 404)', async () => {
    const beacon = createBeacon(baseConfig({ isAdmin: () => true }));
    const app = mount(beacon);
    // funnel requires a `steps` param (else it 400s before the DB); the rest need
    // none. With valid params every handler reaches its query and 500s on the
    // unreachable host — proving the route is mounted and the gates passed.
    const reachable: [string, string][] = [
      ['/schema', ''],
      ['/events', ''],
      ['/aggregate', ''],
      ['/funnel', '?steps=view,signup'],
      ['/attribution', ''],
    ];
    for (const [route, qs] of reachable) {
      const res = await app.request(`/analytics${route}${qs}`);
      expect(res.status).toBe(500); // INTERNAL_ERROR — handler ran; 404 would mean unmounted
      expect(await errCode(res)).toBe('INTERNAL_ERROR');
    }
    void beacon.shutdown().catch(() => {});
  });

  test('the dashboard mounts behind the admin gate: non-admin 403, admin 200 text/html', async () => {
    // Stronger mount proof than the query routes: the dashboard needs no DB
    // (renderShell is pure), so an admin gets a real 200 HTML page, not a 500.
    const denied = createBeacon(baseConfig({ isAdmin: () => false }));
    const deniedRes = await mount(denied).request('/analytics/dashboard');
    expect(deniedRes.status).toBe(403);
    expect(await errCode(deniedRes)).toBe('UNAUTHORIZED');
    void denied.shutdown().catch(() => {});

    const allowed = createBeacon(baseConfig({ isAdmin: () => true }));
    const allowedRes = await mount(allowed).request('/analytics/dashboard');
    expect(allowedRes.status).toBe(200);
    expect(allowedRes.headers.get('content-type')).toContain('text/html');
    expect(await allowedRes.text()).toContain('id="beacon-widget-overview"');
    void allowed.shutdown().catch(() => {});
  });

  test('the ingest POST /events stays public (no admin gate)', async () => {
    const beacon = createBeacon(baseConfig({ isAdmin: () => false }));
    const app = mount(beacon);
    const res = await app.request('/analytics/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: [{ event_type: 'test' }] }),
    });
    // Ingest does not run adminGate — a non-admin is NOT 403. Fire-and-forget
    // buffering accepts the batch (202) even on the unreachable host.
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(202);
    void beacon.shutdown().catch(() => {});
  });

  test('query rate limiter returns 429 + Retry-After once the per-user budget is spent', async () => {
    const beacon = createBeacon(
      baseConfig({ isAdmin: () => true, getUserId: () => 'admin-1', queryRateLimit: 1 }),
    );
    const app = mount(beacon);
    // First query is allowed (reaches the handler → 500 on the unreachable host).
    expect((await app.request('/analytics/schema')).status).toBe(500);
    // Second within the minute is rate-limited before the handler.
    const res = await app.request('/analytics/schema');
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
    expect(await errCode(res)).toBe('RATE_LIMITED');
    void beacon.shutdown().catch(() => {});
  });

  test('the query rate limiter is independent of the ingest endpoint', async () => {
    const beacon = createBeacon(
      baseConfig({ isAdmin: () => true, getUserId: () => 'admin-1', queryRateLimit: 1 }),
    );
    const app = mount(beacon);
    await app.request('/analytics/schema'); // spend the single query slot
    expect((await app.request('/analytics/schema')).status).toBe(429); // query exhausted
    // Ingest has its own limiter — still reachable (not 429 from the query limiter).
    const ingest = await app.request('/analytics/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: [{ event_type: 'test' }] }),
    });
    expect(ingest.status).toBe(202);
    void beacon.shutdown().catch(() => {});
  });
});

// Shortener mounting (§7) — these assert the router is built once and the create
// limiter keys per admin, both without Postgres (the limiter fires before any DB
// call). Round-trip data correctness is the integration suite below + story-007.
describe('createBeacon shortener (mounting + per-admin create limit)', () => {
  /** Mount beacon.shortener() at the root on a fresh app. */
  function mount(beacon: ReturnType<typeof createBeacon>): Hono {
    const app = new Hono();
    app.route('/', beacon.shortener());
    return app;
  }

  test('shortener() returns a Hono router and the same instance on every call', () => {
    const beacon = createBeacon(baseConfig());
    const r1 = beacon.shortener();
    const r2 = beacon.shortener();
    expect(r1).toBeInstanceOf(Hono);
    expect(r1).toBe(r2); // built once so the cache + create-limiter windows persist
    void beacon.shutdown().catch(() => {});
  });

  test('createShortLink() rejects a non-http(s) destination (parity with POST /short, no DB)', async () => {
    // The programmatic path must enforce the same http(s)-only rule as the HTTP
    // create route, so a host app can never mint a javascript:/data: link that the
    // redirect would later 302 to. Validation rejects before the (unreachable) DB.
    const beacon = createBeacon(baseConfig({ shortDomain: 'https://pi.ink' }));
    await expect(
      beacon.createShortLink({ destination: 'javascript:alert(1)', productId: 'p' }),
    ).rejects.toThrow(/http/i);
    void beacon.shutdown().catch(() => {});
  });

  test('the create limiter keys per admin — one admin hitting the cap does not limit another (wires getUserId, §7.2)', async () => {
    // shortLinkCreateRateLimit:1 + getUserId from the x-admin header. Postgres is
    // unreachable, so a slot-consuming POST 500s AFTER the limiter passes; the
    // second POST by the same admin is 429 (its bucket is full) while a different
    // admin's first POST is NOT 429 — proving the limiter keys on getUserId, not a
    // single shared bucket. Without the mount wiring getUserId, all admins would
    // collapse to one ip/'unknown' key and admin-B would be 429 too.
    const beacon = createBeacon(
      baseConfig({
        isAdmin: () => true,
        getUserId: (c) => c.req.header('x-admin') ?? null,
        shortLinkCreateRateLimit: 1,
      }),
    );
    const app = mount(beacon);
    const post = (admin: string) =>
      app.request('/short', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-admin': admin },
        body: JSON.stringify({ destination: 'https://example.com', product_id: 'p' }),
      });

    expect((await post('admin-A')).status).toBe(500); // slot consumed, then DB unreachable
    expect((await post('admin-A')).status).toBe(429); // admin-A's bucket is now full
    expect((await post('admin-B')).status).not.toBe(429); // separate bucket — not limited
    void beacon.shutdown().catch(() => {});
  });

  test('POST /short is admin-gated; a non-admin gets a §5.5 UNAUTHORIZED 403', async () => {
    const beacon = createBeacon(baseConfig({ isAdmin: () => false }));
    const app = mount(beacon);
    const res = await app.request('/short', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ destination: 'https://example.com', product_id: 'p' }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('UNAUTHORIZED');
    void beacon.shutdown().catch(() => {});
  });
});

describe.skipIf(!TEST_DB)('createBeacon shortener (integration, live Postgres)', () => {
  const getDb = withTestDb(TEST_DB as string);

  /** Mount beacon.shortener() at the root on a fresh app. */
  function shortenerApp(beacon: ReturnType<typeof createBeacon>): Hono {
    const app = new Hono();
    app.route('/', beacon.shortener());
    return app;
  }

  test('admin POST /short → 201, visitor GET /:code → 302, and a short_link_click lands after flush', async () => {
    const migrator = getDb();
    const beacon = createBeacon({
      productId: 'beacon-test',
      postgres: { connectionString: TEST_DB as string },
      isAdmin: () => true,
      shortDomain: 'https://pi.ink',
      flushInterval: 60_000,
    });
    const app = shortenerApp(beacon);

    const created = await app.request('/short', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ destination: 'https://example.com/landing', product_id: 'promo' }),
    });
    expect(created.status).toBe(201);
    const link = (await created.json()) as { code: string; url: string };
    expect(link.code).toBeTruthy();
    expect(link.url).toBe(`https://pi.ink/${link.code}`);

    const redirect = await app.request(`/${link.code}`);
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toBe('https://example.com/landing');

    await beacon.flush();
    const rows = await migrator<{ product_id: string; code: string; dest: string }[]>`
      SELECT product_id, properties->>'code' AS code, properties->>'destination' AS dest
      FROM beacon_events WHERE event_type = 'short_link_click'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.product_id).toBe('promo'); // product_id comes from the LINK, not the Beacon
    expect(rows[0]?.code).toBe(link.code);
    expect(rows[0]?.dest).toBe('https://example.com/landing');

    await beacon.shutdown();
  });

  test('createShortLink() persists a link with no HTTP request, and the returned code redirects', async () => {
    getDb();
    const beacon = createBeacon({
      productId: 'beacon-test',
      postgres: { connectionString: TEST_DB as string },
      isAdmin: () => true,
      shortDomain: 'https://pi.ink',
      flushInterval: 60_000,
    });
    const app = shortenerApp(beacon);

    const link = await beacon.createShortLink({
      destination: 'https://example.com/api-made',
      productId: 'promo',
    });
    expect(link.url).toBe(`https://pi.ink/${link.code}`);

    const redirect = await app.request(`/${link.code}`);
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toBe('https://example.com/api-made');

    await beacon.shutdown();
  });
});

describe.skipIf(!TEST_DB)('createBeacon (integration, live Postgres)', () => {
  // Shared migrated client; each Beacon under test opens its own client.
  const getDb = withTestDb(TEST_DB as string);

  test('round-trip: middleware on a Hono app logs a request to Postgres after flush', async () => {
    const migrator = getDb();

    const beacon = createBeacon({
      productId: 'beacon-test',
      postgres: { connectionString: TEST_DB as string },
    });
    const app = new Hono();
    app.use('*', beacon.middleware());
    app.get('/hello', (c) => c.text('hi'));

    const res = await app.request('/hello');
    expect(res.status).toBe(200);

    await beacon.flush();
    const rows = await migrator<{ path: string }[]>`
      SELECT properties->>'path' AS path FROM beacon_events WHERE event_type = 'request'`;
    expect(rows.map((r) => r.path)).toContain('/hello');

    await beacon.shutdown();
  });

  test('E2E: POST {basePath}/events through beacon.router() honors body product_id into Postgres (story-001 AC5)', async () => {
    const migrator = getDb();

    const beacon = createBeacon({
      productId: 'router-host',
      postgres: { connectionString: TEST_DB as string },
      flushInterval: 60_000,
    });
    const app = new Hono();
    app.route(beacon.basePath, beacon.router());

    const res = await app.request('/analytics/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ product_id: 'other-app', events: [{ event_type: 'sdk_ping' }] }),
    });
    expect(res.status).toBe(202);

    await beacon.flush();
    const rows = await migrator<{ product_id: string }[]>`
      SELECT product_id FROM beacon_events WHERE event_type = 'sdk_ping'`;
    expect(rows.map((r) => r.product_id)).toEqual(['other-app']);

    await beacon.shutdown();
  });

  test('E2E: config.trustedIngestToken threads into ingest — a trusted bearer stores per-event user_id (story-003)', async () => {
    const migrator = getDb();

    const beacon = createBeacon({
      productId: 'trust-host',
      postgres: { connectionString: TEST_DB as string },
      trustedIngestToken: 'wiring-secret',
      flushInterval: 60_000,
    });
    const app = new Hono();
    app.route(beacon.basePath, beacon.router());

    const send = (headers: Record<string, string>, eventType: string) =>
      app.request('/analytics/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ events: [{ event_type: eventType, user_id: 'wired-user' }] }),
      });

    const trusted = await send({ authorization: 'Bearer wiring-secret' }, 'trust_wired');
    expect(trusted.status).toBe(202);
    const untrusted = await send({}, 'trust_unwired'); // no bearer → body user_id ignored
    expect(untrusted.status).toBe(202);

    await beacon.flush();
    const rows = await migrator<{ event_type: string; user_id: string | null }[]>`
      SELECT event_type, user_id FROM beacon_events WHERE event_type IN ('trust_wired', 'trust_unwired')`;
    const byType = new Map(rows.map((r) => [r.event_type, r.user_id]));
    expect(byType.get('trust_wired')).toBe('wired-user'); // config wired the token through
    expect(byType.get('trust_unwired')).toBeNull(); // untrusted path unchanged

    await beacon.shutdown();
  });

  test('shutdown() drains buffered events before closing the connection', async () => {
    const migrator = getDb();

    const beacon = createBeacon({
      productId: 'beacon-test',
      postgres: { connectionString: TEST_DB as string },
    });
    const app = new Hono();
    app.use('*', beacon.middleware());
    app.get('/drain', (c) => c.text('ok'));

    await app.request('/drain');
    expect(beacon.stats().buffered).toBe(1);

    await beacon.shutdown(); // must flush the buffered event before closeDb

    const rows = await migrator<{ count: string }[]>`
      SELECT count(*)::int AS count FROM beacon_events WHERE event_type = 'request'`;
    expect(Number(rows[0]?.count)).toBe(1);
  });
});

// associateVisitor integration coverage lives in ./associateVisitor.test.ts
// (split out to keep this file under the 500-line cap).
