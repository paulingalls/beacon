import { describe, expect, test } from 'bun:test';
import { registerDbCoverageGuard, TEST_DB } from '../../test/dbGuard';
import { stubSql, withTestDb } from '../../test/helpers';
import { EventBuffer } from '../events/buffer';
import { associateVisitor } from './associate';
import { VisitorTokenStore } from './tokenStore';

registerDbCoverageGuard();

// The shared associate core (extracted from createBeacon.ts in Milestone 5). These
// tests exercise the exported primitive directly — Beacon.associateVisitor's own
// suite (apps/server/test/associateVisitor.test.ts) covers the via-factory path.

// Failure isolation (§1.3) is DB-free: a rejecting transaction must be swallowed.
test('never throws when the transaction fails — best-effort (§1.3)', async () => {
  const store = new VisitorTokenStore();
  const failing = stubSql({ begin: () => Promise.reject(new Error('boom')) });
  const buffer = new EventBuffer(failing); // empty queue → drain is a no-op
  // Resolves (does not throw) despite the rejecting transaction; returns void.
  const result = await associateVisitor(buffer, failing, store, 'tok', 'user-1');
  expect(result).toBeUndefined();
  store.stop();
});

describe.skipIf(!TEST_DB)('associateVisitor core (integration, live Postgres)', () => {
  const getDb = withTestDb(TEST_DB as string);

  // Seed a known token (in the store, with attribution) plus a two-event trail in
  // the DB with distinct timestamps, all user_id NULL. Returns the token.
  async function seedTrail(
    store: VisitorTokenStore,
    sql: ReturnType<typeof getDb>,
    attribution: Record<string, string> | null,
  ): Promise<string> {
    const token = store.create('ip-hash', 'ua');
    if (attribution) store.setAttribution(token, attribution);
    const earlier = new Date(Date.now() - 1000);
    const later = new Date();
    await sql`
      INSERT INTO beacon_events (product_id, event_type, timestamp, visitor_token)
      VALUES ('beacon-test', 'page_view', ${earlier}, ${token}),
             ('beacon-test', 'page_view', ${later}, ${token})`;
    return token;
  }

  test('back-fills user_id across the trail and writes attribution to the earliest event', async () => {
    const sql = getDb();
    const store = new VisitorTokenStore();
    const buffer = new EventBuffer(sql);
    const token = await seedTrail(store, sql, { utm_source: 'newsletter' });

    await associateVisitor(buffer, sql, store, token, 'user-7');

    const rows = await sql<{ user_id: string | null; src: string | null }[]>`
      SELECT user_id, attribution->>'utm_source' AS src
      FROM beacon_events WHERE visitor_token = ${token}
      ORDER BY timestamp ASC, received_at ASC`;
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.user_id === 'user-7')).toBe(true); // whole trail associated
    expect(rows[0]?.src).toBe('newsletter'); // first-touch on the earliest event
    expect(rows[1]?.src).toBeNull(); // only the earliest
    store.stop();
  });

  test('drains a non-empty buffer before the UPDATE so unflushed trail events are associated', async () => {
    const sql = getDb();
    const store = new VisitorTokenStore();
    const token = store.create('ip-hash', 'ua');
    const buffer = new EventBuffer(sql);
    // Buffer two events without flushing — a login inside the flush window.
    buffer.push({
      productId: 'beacon-test',
      eventType: 'page_view',
      visitorToken: token,
      timestamp: new Date(Date.now() - 1000),
    });
    buffer.push({ productId: 'beacon-test', eventType: 'page_view', visitorToken: token });
    expect(buffer.stats().buffered).toBe(2); // still in memory, not persisted

    await associateVisitor(buffer, sql, store, token, 'user-11');

    expect(buffer.stats().buffered).toBe(0); // drained before the UPDATE
    const rows = await sql<{ user_id: string | null }[]>`
      SELECT user_id FROM beacon_events WHERE visitor_token = ${token}`;
    expect(rows.length).toBe(2); // both flushed, then associated
    expect(rows.every((r) => r.user_id === 'user-11')).toBe(true);
    store.stop();
  });

  test('a second associate is a clean no-op — token removed, user_id guarded by IS NULL', async () => {
    const sql = getDb();
    const store = new VisitorTokenStore();
    const buffer = new EventBuffer(sql);
    const token = await seedTrail(store, sql, { utm_source: 'newsletter' });

    await associateVisitor(buffer, sql, store, token, 'user-7');
    // Wipe attribution so a re-copy would be detectable, then associate again.
    await sql`UPDATE beacon_events SET attribution = '{}'::jsonb WHERE visitor_token = ${token}`;
    await associateVisitor(buffer, sql, store, token, 'user-9');

    const rows = await sql<{ user_id: string | null; src: string | null }[]>`
      SELECT user_id, attribution->>'utm_source' AS src FROM beacon_events WHERE visitor_token = ${token}`;
    expect(rows.every((r) => r.user_id === 'user-7')).toBe(true); // user-9 did NOT clobber (IS NULL guard)
    expect(rows.every((r) => r.src === null)).toBe(true); // attribution NOT re-copied (token removed)
    store.stop();
  });
});
