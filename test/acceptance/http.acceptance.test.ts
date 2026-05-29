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
