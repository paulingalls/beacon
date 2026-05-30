import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createBeacon } from '@pi-innovations/beacon';
import { Hono } from 'hono';

// HTTP acceptance harness for the Beacon server surface. Unlike the in-process
// app.request() unit/e2e tests, this drives a REAL server over the network
// (Bun.serve + fetch) — the higher-fidelity seam that future cross-package
// end-to-end tests (e.g. the beacon-client SDK posting to the ingest endpoint)
// will plug into. Postgres is intentionally unreachable so this smoke needs no
// external services: §1.3 failure isolation keeps the request unaffected by the
// DB outage. As Milestones 4-5 land the ingest + query API, add real acceptance
// scenarios here against a live test database.

describe('http acceptance — Beacon serves real HTTP traffic', () => {
  let server: ReturnType<typeof Bun.serve>;
  let beacon: ReturnType<typeof createBeacon>;
  let baseUrl: string;

  beforeAll(() => {
    beacon = createBeacon({
      productId: 'acceptance',
      postgres: { connectionString: 'postgres://u:p@127.0.0.1:1/db' },
    });
    const app = new Hono();
    app.use('*', beacon.middleware());
    app.get('/health', (c) => c.json({ ok: true }));

    server = Bun.serve({ port: 0, fetch: app.fetch });
    baseUrl = `http://localhost:${server.port}`;
  });

  afterAll(async () => {
    server.stop(true);
    await beacon.shutdown();
  }, 15_000);

  test('GET /health returns 200 over the network AND the middleware logged the request', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // Prove the Beacon middleware actually ran (not a silent no-op): it buffers
    // the request event before the response returns, so the count is now > 0.
    expect(beacon.stats().buffered).toBeGreaterThan(0);
  });
});

/**
 * Stand up a fresh Beacon + real server, run fn(baseUrl), then tear down. A fresh
 * beacon per call means a fresh RateLimiter window, so the 429 test is deterministic.
 * Postgres stays unreachable — the ingest endpoint buffers fire-and-forget and returns
 * 202 regardless of the DB, so this surface needs no external services.
 */
async function withServer(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const beacon = createBeacon({
    productId: 'acceptance',
    postgres: { connectionString: 'postgres://u:p@127.0.0.1:1/db' },
    flushInterval: 60_000,
  });
  const app = new Hono();
  app.use('*', beacon.middleware());
  app.route(beacon.basePath, beacon.router());
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  try {
    await fn(`http://localhost:${server.port}`);
  } finally {
    server.stop(true);
    await beacon.shutdown();
  }
}

function postEvents(baseUrl: string, events: unknown[]): Promise<Response> {
  return fetch(`${baseUrl}/analytics/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events }),
  });
}

describe('http acceptance — POST /analytics/events ingest over the network', () => {
  test('accepts an event batch and returns 202 { accepted } over the wire', async () => {
    await withServer(async (baseUrl) => {
      const res = await postEvents(baseUrl, [
        { event_type: 'screen_view' },
        { event_type: 'button_tap' },
      ]);
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ accepted: 2 });
    });
  }, 15_000);

  test('rate-limits a caller past the per-minute limit with a 429 + Retry-After', async () => {
    await withServer(async (baseUrl) => {
      // Default limit is 10/min per caller. Unauthenticated, so the identifier is the
      // resolved client IP — stable across these localhost fetches (and if getConnInfo
      // yields nothing, ingest's 'unknown' sentinel keys them together just the same),
      // so request 11 deterministically trips the window.
      for (let i = 0; i < 10; i++) {
        const ok = await postEvents(baseUrl, [{ event_type: 'e' }]);
        expect(ok.status).toBe(202);
      }
      const denied = await postEvents(baseUrl, [{ event_type: 'e' }]);
      expect(denied.status).toBe(429);
      expect(Number(denied.headers.get('Retry-After'))).toBeGreaterThan(0);
    });
  }, 15_000);
});
