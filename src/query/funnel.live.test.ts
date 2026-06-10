import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { Hono } from 'hono';
import type { Sql } from 'postgres';

import { closeDb, createDb } from '../storage/db';
import { runMigrations } from '../storage/migrate';
import { createFunnelHandler } from './funnel';

const TEST_DB = process.env.TEST_DATABASE_URL;

// db-coverage guard (decision a02afa9ca404): a silent skip hides coverage gaps. Fail loud when
// the DB is expected but unset; the only sanctioned skip is the explicit BEACON_TEST_DB=off opt-out.
test('DB coverage: TEST_DATABASE_URL is set unless the DB is explicitly opted out', () => {
  expect(Boolean(TEST_DB) || process.env.BEACON_TEST_DB === 'off').toBe(true);
});

// The §5.4 response shape (mirrors funnel.test.ts; the shared test-kit extraction
// is deferred — concern ecfead961fb9 / plan Milestone 2).
interface FunnelStep {
  event_type: string;
  count: number;
  conversion_rate: number;
}
interface FunnelResponse {
  steps: FunnelStep[];
  overall_conversion: number;
  window_seconds: number;
  filters: { product_id?: string; after?: string };
}

// A wide common time range so the 30-day default never excludes fixtures.
const RANGE = 'after=2026-01-01T00:00:00Z&before=2027-01-01T00:00:00Z';

/**
 * Compact batch insert. Each row is [entity, event_type, iso]. `via` chooses the
 * id column so the same fixtures can exercise both branches of the entity
 * expression COALESCE(user_id, visitor_token): 'user' (default) or 'visitor'.
 */
async function seed(
  sql: Sql,
  rows: ReadonlyArray<readonly [string, string, string]>,
  opts: { product?: string; via?: 'user' | 'visitor' } = {},
): Promise<void> {
  const product = opts.product ?? 'p';
  const col = opts.via === 'visitor' ? 'visitor_token' : 'user_id';
  for (const [entity, type, ts] of rows) {
    await sql`
      INSERT INTO beacon_events (product_id, event_type, ${sql(col)}, timestamp)
      VALUES (${product}, ${type}, ${entity}, ${ts})`;
  }
}

describe.skipIf(!TEST_DB)('createFunnelHandler funnel walk (live Postgres)', () => {
  let sql: Sql;

  /** Run the funnel endpoint against the seeded DB and return the parsed §5.4 body. */
  async function runFunnel(extraQs: string): Promise<FunnelResponse> {
    const app = new Hono();
    app.get('/funnel', createFunnelHandler(sql));
    const res = await app.request(`/funnel?${RANGE}&${extraQs}`);
    expect(res.status).toBe(200);
    return (await res.json()) as FunnelResponse;
  }

  /** Convenience: just the per-step counts. */
  async function counts(extraQs: string): Promise<number[]> {
    return (await runFunnel(extraQs)).steps.map((s) => s.count);
  }

  beforeAll(async () => {
    sql = createDb({ connectionString: TEST_DB as string });
    await sql`DROP TABLE IF EXISTS beacon_events, beacon_short_links, beacon_meta, beacon_migrations CASCADE`;
    await runMigrations(sql);
  });

  beforeEach(async () => {
    await sql`TRUNCATE beacon_events, beacon_meta`;
  });

  afterAll(async () => {
    await sql`DROP TABLE IF EXISTS beacon_events, beacon_short_links, beacon_meta, beacon_migrations CASCADE`;
    await closeDb(sql);
  });

  // ── The nine semantics scenarios, re-encoded from the former pure unit tests ──
  // The funnel walk now runs entirely in SQL; these seed the exact same fixtures
  // against live Postgres and assert identical per-step counts.

  test('counts a clean 3-step progression and its conversion rates', async () => {
    await seed(sql, [
      ['u1', 'request', '2026-03-01T00:00:00Z'],
      ['u1', 'signup', '2026-03-01T01:00:00Z'],
      ['u1', 'clip_created', '2026-03-01T02:00:00Z'],
      ['u2', 'request', '2026-03-01T00:00:00Z'],
      ['u2', 'signup', '2026-03-01T01:00:00Z'],
      ['u3', 'request', '2026-03-01T00:00:00Z'],
    ]);
    const body = await runFunnel('steps=request,signup,clip_created');
    expect(body.steps.map((s) => s.count)).toEqual([3, 2, 1]);
    expect(body.steps[1]?.conversion_rate).toBeCloseTo(2 / 3, 10);
    expect(body.steps[2]?.conversion_rate).toBeCloseTo(0.5, 10);
    expect(body.overall_conversion).toBeCloseTo(1 / 3, 10); // last / first
  });

  test('excludes an entity whose later step falls outside the window', async () => {
    await seed(sql, [
      ['u1', 'request', '2026-03-01T00:00:00Z'],
      ['u1', 'signup', '2026-03-01T02:00:00Z'],
      ['u1', 'clip_created', '2026-03-01T03:00:00Z'],
      ['u2', 'request', '2026-03-01T00:00:00Z'],
      ['u2', 'signup', '2026-03-01T05:00:00Z'],
      ['u2', 'clip_created', '2026-03-02T00:00:01Z'], // > anchor + 86400s
    ]);
    expect(await counts('steps=request,signup,clip_created')).toEqual([2, 2, 1]);
  });

  test('window is anchor-relative, not per-hop', async () => {
    // window=100s, anchor at t=0. step2 at +90s (within), step3 at +180s — past
    // anchor+100s though within step2+100s. Anchor-relative reading excludes it.
    await seed(sql, [
      ['u1', 'a', '2026-03-01T00:00:00Z'],
      ['u1', 'b', '2026-03-01T00:01:30Z'],
      ['u1', 'c', '2026-03-01T00:03:00Z'],
    ]);
    expect(await counts('steps=a,b,c&window=100')).toEqual([1, 1, 0]);
  });

  test('an entity that skips a middle step is dropped from later steps', async () => {
    // u1 has a clip_created but never signed up → must not count toward step 3.
    await seed(sql, [
      ['u1', 'request', '2026-03-01T00:00:00Z'],
      ['u1', 'clip_created', '2026-03-01T02:00:00Z'],
      ['u2', 'request', '2026-03-01T00:00:00Z'],
      ['u2', 'signup', '2026-03-01T01:00:00Z'],
      ['u2', 'clip_created', '2026-03-01T02:00:00Z'],
    ]);
    expect(await counts('steps=request,signup,clip_created')).toEqual([2, 1, 1]);
  });

  test('out-of-order completion does not count (step N+1 before step N)', async () => {
    await seed(sql, [
      ['u1', 'signup', '2026-03-01T00:00:00Z'],
      ['u1', 'request', '2026-03-01T01:00:00Z'],
    ]);
    expect(await counts('steps=request,signup')).toEqual([1, 0]);
  });

  test('a simultaneous next-step event does not count (strictly after)', async () => {
    await seed(sql, [
      ['u1', 'a', '2026-03-01T00:00:00Z'],
      ['u1', 'b', '2026-03-01T00:00:00Z'],
    ]);
    expect(await counts('steps=a,b')).toEqual([1, 0]);
  });

  test('anchors on the earliest step-1 event', async () => {
    // Earliest request at 00:00; signup at 23:00 is inside the 24h window.
    await seed(sql, [
      ['u1', 'request', '2026-03-01T00:00:00Z'],
      ['u1', 'request', '2026-03-01T12:00:00Z'],
      ['u1', 'signup', '2026-03-01T23:00:00Z'],
    ]);
    expect(await counts('steps=request,signup')).toEqual([1, 1]);
  });

  test('no step-1 events yields all zeros', async () => {
    await seed(sql, [['u1', 'signup', '2026-03-01T00:00:00Z']]);
    expect(await counts('steps=request,signup,clip_created')).toEqual([0, 0, 0]);
  });

  test('an empty table yields all zeros', async () => {
    expect(await counts('steps=a,b,c')).toEqual([0, 0, 0]);
  });

  // ── Filters and the COALESCE entity branches ─────────────────────────────────

  test('window expiry and step-skip exclusions hold against real SQL', async () => {
    await seed(sql, [
      ['u1', 'a', '2026-03-01T00:00:00Z'],
      ['u1', 'b', '2026-03-01T00:30:00Z'], // within the 3600s window
      ['u2', 'a', '2026-03-01T00:00:00Z'],
      ['u2', 'b', '2026-03-01T02:00:00Z'], // past the 3600s window → excluded
      ['u3', 'a', '2026-03-01T00:00:00Z'], // only step a
    ]);
    const body = await runFunnel('product_id=p&steps=a,b&window=3600');
    expect(body.steps.map((s) => s.count)).toEqual([3, 1]);
    expect(body.overall_conversion).toBeCloseTo(1 / 3, 10);
  });

  test('product_id filter scopes the funnel to one product', async () => {
    await seed(
      sql,
      [
        ['u1', 'a', '2026-03-01T00:00:00Z'],
        ['u1', 'b', '2026-03-01T01:00:00Z'],
      ],
      {
        product: 'p1',
      },
    );
    await seed(
      sql,
      [
        ['u2', 'a', '2026-03-01T00:00:00Z'],
        ['u2', 'b', '2026-03-01T01:00:00Z'],
      ],
      {
        product: 'p2',
      },
    );
    expect(await counts('product_id=p1&steps=a,b')).toEqual([1, 1]);
  });

  test('resolves entities via the visitor_token branch of COALESCE', async () => {
    // Same clean-progression fixture, but seeded with visitor_token (no user_id),
    // proving COALESCE(user_id, visitor_token) and the entity index cover the
    // visitor branch — the user_id-seeded fixtures above never exercise it.
    await seed(
      sql,
      [
        ['v1', 'request', '2026-03-01T00:00:00Z'],
        ['v1', 'signup', '2026-03-01T01:00:00Z'],
        ['v1', 'clip_created', '2026-03-01T02:00:00Z'],
        ['v2', 'request', '2026-03-01T00:00:00Z'],
        ['v2', 'signup', '2026-03-01T01:00:00Z'],
        ['v3', 'request', '2026-03-01T00:00:00Z'],
      ],
      { via: 'visitor' },
    );
    expect(await counts('steps=request,signup,clip_created')).toEqual([3, 2, 1]);
  });

  test('high-cardinality fixture: many entities resolve correctly', async () => {
    // 50 entities request; the first 30 also sign up. Exercises the entity-step
    // index over many distinct entities and gives a realistic fixture for the
    // EXPLAIN-verify step.
    const rows: Array<readonly [string, string, string]> = [];
    for (let i = 0; i < 50; i++) {
      rows.push([`u${i}`, 'request', '2026-03-01T00:00:00Z']);
      if (i < 30) rows.push([`u${i}`, 'signup', '2026-03-01T01:00:00Z']);
    }
    await seed(sql, rows);
    expect(await counts('steps=request,signup')).toEqual([50, 30]);
  });
});
