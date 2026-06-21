import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import { registerDbCoverageGuard, TEST_DB } from '../test/dbGuard';
import { withTestDb } from '../test/helpers';
import { buildServer } from './server';

// Smoke test for the first-party host app (sprint-012 story-001). Boots the app via
// buildServer (no port bind — Hono apps are directly fetchable) and exercises the four
// surfaces it serves plus the DB-free /health probe. DB-gated like the rest of the
// integration suite: the bunfig preload resolves TEST_DATABASE_URL before this evaluates.
registerDbCoverageGuard();

const ADMIN_TOKEN = 'test-admin-secret';

describe.skipIf(!TEST_DB)('apps/server host', () => {
  // Shared migrated client (canonical integration lifecycle): beforeAll migrate, beforeEach
  // TRUNCATE beacon_events+beacon_meta, afterAll drop+close. Used for verification SELECTs —
  // a connection separate from each app's own beacon client, reading committed rows post-flush.
  const getSql = withTestDb(TEST_DB as string);

  // withTestDb only truncates beacon_events/beacon_meta; clear short links here so codes
  // don't accumulate across the suite.
  beforeEach(async () => {
    await getSql()`TRUNCATE beacon_short_links`;
  });

  // Every buildServer opens a Postgres client + starts a buffer flush timer; collect them
  // so afterAll can shut them all down and no timer/connection leaks past the suite.
  const built: Array<ReturnType<typeof buildServer>['beacon']> = [];
  const build = (env: Record<string, string | undefined>) => {
    const result = buildServer(env);
    built.push(result.beacon);
    return result;
  };

  afterAll(async () => {
    await Promise.all(built.map((beacon) => beacon.shutdown()));
  });

  test('GET /health answers 200 without touching Postgres', async () => {
    // Point at an unreachable DB. createDb is fail-soft (REQUIREMENTS §1.3 — never throws),
    // so buildServer still succeeds; /health answering 200 proves it issues no query.
    const { app } = build({ DATABASE_URL: 'postgres://beacon:beacon@127.0.0.1:1/beacon' });
    const res = await app.fetch(new Request('http://host/health'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  test('ingest lands events under the batch product_id', async () => {
    const { app, beacon } = build({ DATABASE_URL: TEST_DB });
    const res = await app.fetch(
      new Request('http://host/analytics/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ product_id: 'other-app', events: [{ event_type: 'smoke' }] }),
      }),
    );
    expect(res.status).toBe(202);

    await beacon.flush();
    const rows = await getSql()<
      { product_id: string }[]
    >`SELECT product_id FROM beacon_events WHERE event_type = 'smoke'`;
    expect(rows.map((r) => r.product_id)).toContain('other-app');
  });

  test('GET /:code 302-redirects to the destination and logs a short_link_click', async () => {
    const { app, beacon } = build({ DATABASE_URL: TEST_DB });
    const link = await beacon.createShortLink({
      destination: 'https://example.com/landing',
      productId: 'beacon',
    });

    const res = await app.fetch(new Request(`http://host/${link.code}`, { redirect: 'manual' }));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://example.com/landing');

    await beacon.flush();
    const rows = await getSql()`SELECT 1 FROM beacon_events WHERE event_type = 'short_link_click'`;
    expect(rows.length).toBeGreaterThan(0);
  });

  test('dashboard is admin-gated by the ADMIN_TOKEN bearer', async () => {
    const { app } = build({ DATABASE_URL: TEST_DB, ADMIN_TOKEN });

    const denied = await app.fetch(new Request('http://host/analytics/dashboard'));
    expect(denied.status).toBe(403);

    const allowed = await app.fetch(
      new Request('http://host/analytics/dashboard', {
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      }),
    );
    expect(allowed.status).toBe(200);
  });

  test('dashboard fails closed when ADMIN_TOKEN is unset', async () => {
    const { app } = build({ DATABASE_URL: TEST_DB });
    const res = await app.fetch(
      new Request('http://host/analytics/dashboard', {
        headers: { authorization: 'Bearer anything' },
      }),
    );
    expect(res.status).toBe(403);
  });

  test('TRUSTED_INGEST_TOKEN env threads trust into ingest — a bearer-authorized batch stores per-event user_id', async () => {
    const TRUSTED = 'test-trusted-ingest';
    const { app, beacon } = build({ DATABASE_URL: TEST_DB, TRUSTED_INGEST_TOKEN: TRUSTED });

    const send = (headers: Record<string, string>, eventType: string) =>
      app.fetch(
        new Request('http://host/analytics/events', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify({ events: [{ event_type: eventType, user_id: 'host-wired-user' }] }),
        }),
      );

    expect((await send({ authorization: `Bearer ${TRUSTED}` }, 'host_trusted')).status).toBe(202);
    expect((await send({}, 'host_untrusted')).status).toBe(202); // no bearer → body user_id ignored

    await beacon.flush();
    const rows = await getSql()<{ event_type: string; user_id: string | null }[]>`
      SELECT event_type, user_id FROM beacon_events WHERE event_type IN ('host_trusted', 'host_untrusted')`;
    const byType = new Map(rows.map((r) => [r.event_type, r.user_id]));
    expect(byType.get('host_trusted')).toBe('host-wired-user'); // env → createBeacon → ingest
    expect(byType.get('host_untrusted')).toBeNull(); // public path unchanged
  });

  test('trusted ingest fails closed when TRUSTED_INGEST_TOKEN is unset', async () => {
    const { app, beacon } = build({ DATABASE_URL: TEST_DB });
    const res = await app.fetch(
      new Request('http://host/analytics/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer anything' },
        body: JSON.stringify({ events: [{ event_type: 'host_failclosed', user_id: 'spoofed' }] }),
      }),
    );
    expect(res.status).toBe(202);

    await beacon.flush();
    const rows = await getSql()<{ user_id: string | null }[]>`
      SELECT user_id FROM beacon_events WHERE event_type = 'host_failclosed'`;
    expect(rows.map((r) => r.user_id)).toEqual([null]); // unset token ⇒ body user_id ignored
  });
});
