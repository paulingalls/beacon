import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { createBeacon } from '../src/createBeacon';
import { registerDbCoverageGuard, TEST_DB } from './dbGuard';
import { ctxWith, withTestDb } from './helpers';

registerDbCoverageGuard();

describe.skipIf(!TEST_DB)('associateVisitor (integration, live Postgres)', () => {
  const getDb = withTestDb(TEST_DB as string);

  // Drive an anonymous trail through the middleware (mints a token + captures
  // attribution in the beacon's store), flush it, and return the token.
  async function anonymousTrail(beacon: ReturnType<typeof createBeacon>): Promise<string> {
    const app = new Hono();
    app.use('*', beacon.middleware());
    app.get('/p', (c) => c.text(beacon.getVisitorToken(c) ?? 'none'));

    const first = await app.request('/p?utm_source=newsletter&utm_campaign=spring');
    const token = await first.text();
    // Each request now stamps its own event-time at request start, so a small
    // gap makes the two events' timestamps distinct and the earliest-event
    // attribution assertion deterministic (not dependent on insertion order).
    await Bun.sleep(2);
    await app.request(`/p?_t=${token}`); // second hit reuses the token
    await beacon.flush();
    return token;
  }

  test('back-fills user_id across the trail and writes attribution to the earliest event', async () => {
    const migrator = getDb();
    const beacon = createBeacon({
      productId: 'beacon-test',
      postgres: { connectionString: TEST_DB as string },
    });
    const token = await anonymousTrail(beacon);

    await beacon.associateVisitor(ctxWith(token), 'user-7');

    const rows = await migrator<{ user_id: string | null; src: string | null }[]>`
      SELECT user_id, attribution->>'utm_source' AS src
      FROM beacon_events WHERE visitor_token = ${token}
      ORDER BY timestamp ASC, received_at ASC`;
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((r) => r.user_id === 'user-7')).toBe(true); // whole trail associated
    expect(rows[0]?.src).toBe('newsletter'); // attribution on the earliest event
    expect(rows.slice(1).every((r) => r.src === null)).toBe(true); // only the earliest

    await beacon.shutdown();
  });

  test('fast login: associateVisitor flushes the buffer first, so unflushed trail events are still associated', async () => {
    const migrator = getDb();
    const beacon = createBeacon({
      productId: 'beacon-test',
      postgres: { connectionString: TEST_DB as string },
    });
    const app = new Hono();
    app.use('*', beacon.middleware());
    app.get('/p', (c) => c.text(beacon.getVisitorToken(c) ?? 'none'));

    // Drive a trail but deliberately do NOT flush — events stay in the buffer,
    // simulating a login inside the flush window.
    const first = await app.request('/p?utm_source=newsletter');
    const token = await first.text();
    await Bun.sleep(2);
    await app.request(`/p?_t=${token}`);
    expect(beacon.stats().buffered).toBe(2); // still in memory, not persisted

    await beacon.associateVisitor(ctxWith(token), 'user-11');

    const rows = await migrator<{ user_id: string | null; src: string | null }[]>`
      SELECT user_id, attribution->>'utm_source' AS src
      FROM beacon_events WHERE visitor_token = ${token}
      ORDER BY timestamp ASC, received_at ASC`;
    expect(rows.length).toBe(2); // both buffered events were flushed before the UPDATE
    expect(rows.every((r) => r.user_id === 'user-11')).toBe(true);
    expect(rows[0]?.src).toBe('newsletter'); // first-touch attribution preserved

    await beacon.shutdown();
  });

  test('a second associate is a clean no-op — token removed, user_id guarded by IS NULL', async () => {
    const migrator = getDb();
    const beacon = createBeacon({
      productId: 'beacon-test',
      postgres: { connectionString: TEST_DB as string },
    });
    const token = await anonymousTrail(beacon);

    await beacon.associateVisitor(ctxWith(token), 'user-7');
    // Wipe attribution so a re-copy would be detectable, then associate again.
    await migrator`UPDATE beacon_events SET attribution = '{}'::jsonb WHERE visitor_token = ${token}`;
    await beacon.associateVisitor(ctxWith(token), 'user-9');

    const rows = await migrator<{ user_id: string | null; src: string | null }[]>`
      SELECT user_id, attribution->>'utm_source' AS src FROM beacon_events WHERE visitor_token = ${token}`;
    expect(rows.every((r) => r.user_id === 'user-7')).toBe(true); // user-9 did NOT clobber (WHERE user_id IS NULL)
    expect(rows.every((r) => r.src === null)).toBe(true); // attribution NOT re-copied (token removed from store)

    await beacon.shutdown();
  });

  test('only the null-user_id rows are associated, leaving already-attributed events untouched', async () => {
    const migrator = getDb();
    const beacon = createBeacon({
      productId: 'beacon-test',
      postgres: { connectionString: TEST_DB as string },
    });
    const token = await anonymousTrail(beacon);
    // Pre-associate one row to a different user; associate must not clobber it.
    await migrator`
      UPDATE beacon_events SET user_id = 'existing-user'
      WHERE event_id = (SELECT event_id FROM beacon_events WHERE visitor_token = ${token} ORDER BY timestamp DESC LIMIT 1)`;

    await beacon.associateVisitor(ctxWith(token), 'user-7');

    const rows = await migrator<{ user_id: string }[]>`
      SELECT user_id FROM beacon_events WHERE visitor_token = ${token}`;
    const ids = rows.map((r) => r.user_id).sort();
    expect(ids).toContain('existing-user'); // untouched
    expect(ids).toContain('user-7'); // the null row got associated

    await beacon.shutdown();
  });
});
