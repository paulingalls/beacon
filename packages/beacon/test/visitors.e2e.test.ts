import { describe, expect, test } from 'bun:test';
import type { Context } from 'hono';
import { Hono } from 'hono';

import { createBeacon } from '../src/index';
import { withTestDb } from './helpers';

const TEST_DB = process.env.TEST_DATABASE_URL;

// db-coverage guard (decision a02afa9ca404): a silent skip hides coverage gaps. Fail loud when
// the DB is expected but unset; the only sanctioned skip is the explicit BEACON_TEST_DB=off opt-out.
test('DB coverage: TEST_DATABASE_URL is set unless the DB is explicitly opted out', () => {
  expect(Boolean(TEST_DB) || process.env.BEACON_TEST_DB === 'off').toBe(true);
});

/** Host-supplied context carrying the visitor's token, as at the login moment. */
const ctxWith = (token?: string): Context =>
  ({
    get: (key: string) => (key === 'beaconVisitorToken' ? token : undefined),
  }) as unknown as Context;

// Capstone for Milestone 3: proves the visitor token store (story-001), the
// attribution extractor (story-002), the middleware integration (story-003),
// and the public association API (story-004) compose into one end-to-end
// anonymous→authenticated journey — and that §1.3 failure isolation holds.

describe('Capstone — visitor journey resilience (no Postgres)', () => {
  test('mints a token, and associateVisitor never crashes the host with Postgres down', async () => {
    // Well-formed but unreachable: the in-memory token store still works, but
    // every DB write rejects — the host must be unaffected throughout.
    const beacon = createBeacon({
      productId: 'beacon-test',
      postgres: { connectionString: 'postgres://u:p@127.0.0.1:1/db' },
    });
    const app = new Hono();
    app.use('*', beacon.middleware());
    app.get('/p', (c) => c.text(beacon.getVisitorToken(c) ?? 'none'));

    // Anonymous hit mints a token even with Postgres down (store is in-memory).
    const res = await app.request('/p');
    const token = await res.text();
    expect(res.status).toBe(200);
    expect(token).toMatch(/^[A-Za-z0-9_-]{12}$/);

    // associateVisitor drains + UPDATEs against the down DB → caught, resolves.
    await expect(beacon.associateVisitor(ctxWith(token), 'user-7')).resolves.toBeUndefined();
    // No token in context (direct login) → clean no-op.
    await expect(beacon.associateVisitor(ctxWith(undefined), 'user-7')).resolves.toBeUndefined();

    await expect(beacon.shutdown()).resolves.toBeUndefined();
  }, 15_000);
});

describe.skipIf(!TEST_DB)('Capstone — visitor journey (live Postgres)', () => {
  const getDb = withTestDb(TEST_DB as string);

  test('mint + first-touch attribution, _t reuse across hits, then associate back-fills the whole trail', async () => {
    const migrator = getDb();
    const beacon = createBeacon({
      productId: 'beacon-test',
      postgres: { connectionString: TEST_DB as string },
    });
    const app = new Hono();
    app.use('*', beacon.middleware());
    app.get('/landing', (c) => c.text(beacon.getVisitorToken(c) ?? 'none'));
    app.get('/page', (c) => c.text('hi'));

    // 1. First anonymous hit with campaign params and no _t → mints a token.
    const first = await app.request('/landing?utm_source=newsletter&utm_campaign=spring&gclid=abc');
    const token = await first.text();
    expect(token).toMatch(/^[A-Za-z0-9_-]{12}$/);

    // 2. Subsequent hits carrying ?_t={token} reuse the SAME token. The gaps
    //    give /landing a strictly-earlier request-time than either /page, so the
    //    genuine first hit is unambiguous even under ms-resolution timestamps and
    //    timer coalescing — making the first-touch assertion below deterministic.
    await Bun.sleep(5);
    await app.request(`/page?_t=${token}`);
    await Bun.sleep(5);
    await app.request(`/page?_t=${token}`);

    await beacon.flush();

    // The whole trail shares one visitor_token and is anonymous so far.
    const before = await migrator<{ user_id: string | null; vt: string }[]>`
      SELECT user_id, visitor_token AS vt FROM beacon_events
      WHERE event_type = 'request' ORDER BY timestamp ASC, received_at ASC`;
    expect(before.length).toBe(3);
    expect(before.every((r) => r.vt === token)).toBe(true);
    expect(before.every((r) => r.user_id === null)).toBe(true);

    // 3. On login the host associates the trail with the authenticated user.
    await beacon.associateVisitor(ctxWith(token), 'user-7');

    // Assert by PATH, not by position: independent ground truth that does not
    // reuse production's ORDER BY. First-touch attribution must land on exactly
    // ONE event — the genuine first hit (/landing) — and on no /page hit.
    const after = await migrator<{ user_id: string | null; path: string; src: string | null }[]>`
      SELECT user_id, properties->>'path' AS path, attribution->>'utm_source' AS src
      FROM beacon_events WHERE visitor_token = ${token}`;
    expect(after.length).toBe(3);
    expect(after.every((r) => r.user_id === 'user-7')).toBe(true); // whole trail associated
    const attributed = after.filter((r) => r.src !== null);
    expect(attributed.length).toBe(1); // first-touch attribution copied to exactly one event
    expect(attributed[0]?.path).toBe('/landing'); // and it is the genuine first hit
    expect(attributed[0]?.src).toBe('newsletter');

    // 4. The token is consumed: a second associate is a clean no-op — it does
    //    not re-associate (user_id IS NULL guard) or re-copy attribution.
    await migrator`UPDATE beacon_events SET attribution = '{}'::jsonb WHERE visitor_token = ${token}`;
    await beacon.associateVisitor(ctxWith(token), 'user-9');
    const replay = await migrator<{ user_id: string; src: string | null }[]>`
      SELECT user_id, attribution->>'utm_source' AS src FROM beacon_events WHERE visitor_token = ${token}`;
    expect(replay.every((r) => r.user_id === 'user-7')).toBe(true); // not clobbered to user-9
    expect(replay.every((r) => r.src === null)).toBe(true); // attribution not re-copied (token gone)

    await beacon.shutdown();
  });
});
