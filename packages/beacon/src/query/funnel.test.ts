import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { Hono } from 'hono';
import type { Sql } from 'postgres';

import { QueryParamError } from '../api/params';
import { closeDb, createDb } from '../storage/db';
import { runMigrations } from '../storage/migrate';
import {
  computeFunnelCounts,
  createFunnelHandler,
  type FunnelRow,
  MissingParamError,
  parseSteps,
  parseWindow,
} from './funnel';

const TEST_DB = process.env.TEST_DATABASE_URL;

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

/** Build a FunnelRow with a Date timestamp from an ISO string. */
function row(entity: string, event_type: string, iso: string): FunnelRow {
  return { entity, event_type, timestamp: new Date(iso) };
}

// ── parseSteps (pure) ──────────────────────────────────────────────────────

describe('parseSteps', () => {
  test('splits and trims a comma-separated list', () => {
    expect(parseSteps('request, signup ,clip_created')).toEqual([
      'request',
      'signup',
      'clip_created',
    ]);
  });

  test('missing or blank value throws MissingParamError', () => {
    expect(() => parseSteps(undefined)).toThrow(MissingParamError);
    expect(() => parseSteps('')).toThrow(MissingParamError);
    expect(() => parseSteps('   ')).toThrow(MissingParamError);
  });

  test('fewer than 2 steps throws QueryParamError', () => {
    expect(() => parseSteps('request')).toThrow(QueryParamError);
    // A trailing comma collapses to a single real step.
    expect(() => parseSteps('request,')).toThrow(QueryParamError);
  });

  test('more than 10 steps throws QueryParamError', () => {
    const eleven = Array.from({ length: 11 }, (_, i) => `s${i}`).join(',');
    expect(() => parseSteps(eleven)).toThrow(QueryParamError);
  });

  test('accepts the 2..10 boundary counts', () => {
    expect(parseSteps('a,b')).toHaveLength(2);
    expect(parseSteps(Array.from({ length: 10 }, (_, i) => `s${i}`).join(','))).toHaveLength(10);
  });
});

// ── parseWindow (pure) ─────────────────────────────────────────────────────

describe('parseWindow', () => {
  test('defaults to 86400 when absent or blank', () => {
    expect(parseWindow(undefined)).toBe(86400);
    expect(parseWindow('  ')).toBe(86400);
  });

  test('passes through a positive integer', () => {
    expect(parseWindow('3600')).toBe(3600);
  });

  test('rejects zero, negative, and non-integer values', () => {
    expect(() => parseWindow('0')).toThrow(QueryParamError);
    expect(() => parseWindow('-1')).toThrow(QueryParamError);
    expect(() => parseWindow('1.5')).toThrow(QueryParamError);
    expect(() => parseWindow('abc')).toThrow(QueryParamError);
  });
});

// ── computeFunnelCounts (pure) ─────────────────────────────────────────────

describe('computeFunnelCounts', () => {
  const STEPS = ['request', 'signup', 'clip_created'];
  const WINDOW = 86400; // 24h

  test('counts a clean 3-step progression', () => {
    const rows = [
      row('u1', 'request', '2026-03-01T00:00:00Z'),
      row('u1', 'signup', '2026-03-01T01:00:00Z'),
      row('u1', 'clip_created', '2026-03-01T02:00:00Z'),
      // u2 stops after signup.
      row('u2', 'request', '2026-03-01T00:00:00Z'),
      row('u2', 'signup', '2026-03-01T01:00:00Z'),
      // u3 only requests.
      row('u3', 'request', '2026-03-01T00:00:00Z'),
    ];
    expect(computeFunnelCounts(rows, STEPS, WINDOW)).toEqual([3, 2, 1]);
  });

  test('excludes an entity whose later step falls outside the window', () => {
    // u1 finishes within 24h; u2's clip_created is one second past the deadline.
    const rows = [
      row('u1', 'request', '2026-03-01T00:00:00Z'),
      row('u1', 'signup', '2026-03-01T02:00:00Z'),
      row('u1', 'clip_created', '2026-03-01T03:00:00Z'),
      row('u2', 'request', '2026-03-01T00:00:00Z'),
      row('u2', 'signup', '2026-03-01T05:00:00Z'),
      row('u2', 'clip_created', '2026-03-02T00:00:01Z'), // > anchor + 86400s
    ];
    expect(computeFunnelCounts(rows, STEPS, WINDOW)).toEqual([2, 2, 1]);
  });

  test('an entity that skips a middle step is dropped from later steps', () => {
    // u1 never signs up but does have a clip_created; it must not count for step 3.
    const rows = [
      row('u1', 'request', '2026-03-01T00:00:00Z'),
      row('u1', 'clip_created', '2026-03-01T02:00:00Z'),
      row('u2', 'request', '2026-03-01T00:00:00Z'),
      row('u2', 'signup', '2026-03-01T01:00:00Z'),
      row('u2', 'clip_created', '2026-03-01T02:00:00Z'),
    ];
    expect(computeFunnelCounts(rows, STEPS, WINDOW)).toEqual([2, 1, 1]);
  });

  test('out-of-order completion does not count (step N+1 before step N)', () => {
    // u1's signup precedes its request → no qualifying signup after the anchor.
    const rows = [
      row('u1', 'signup', '2026-03-01T00:00:00Z'),
      row('u1', 'request', '2026-03-01T01:00:00Z'),
    ];
    expect(computeFunnelCounts(rows, ['request', 'signup'], WINDOW)).toEqual([1, 0]);
  });

  test('a simultaneous next-step event does not count (strictly after)', () => {
    const ts = '2026-03-01T00:00:00Z';
    expect(
      computeFunnelCounts([row('u1', 'a', ts), row('u1', 'b', ts)], ['a', 'b'], WINDOW),
    ).toEqual([1, 0]);
  });

  test('anchors on the earliest step-1 event', () => {
    // Earliest request is at 00:00; signup at 23:00 is inside the 24h window.
    const rows = [
      row('u1', 'request', '2026-03-01T00:00:00Z'),
      row('u1', 'request', '2026-03-01T12:00:00Z'),
      row('u1', 'signup', '2026-03-01T23:00:00Z'),
    ];
    expect(computeFunnelCounts(rows, ['request', 'signup'], WINDOW)).toEqual([1, 1]);
  });

  test('no step-1 events yields all zeros', () => {
    const rows = [row('u1', 'signup', '2026-03-01T00:00:00Z')];
    expect(computeFunnelCounts(rows, STEPS, WINDOW)).toEqual([0, 0, 0]);
  });
});

// ── createFunnelHandler: param validation & error isolation (no DB) ─────────

/**
 * An `Sql` stub whose every tagged-template call resolves to the SAME rows
 * array. The handler issues a single query (composed from conditional
 * fragments), so one pre-resolved promise reused across the discarded
 * intermediates lets the final `await` see the rows — exercising the full
 * compute + response path with no database. Mirrors events.test's rejectingSql.
 */
function rowsSql(rows: FunnelRow[]): Sql {
  const resolved = Promise.resolve(rows);
  const builder = () => resolved;
  return builder as unknown as Sql;
}

/** An `Sql` stub whose query rejects, to exercise the 500 path. */
function rejectingSql(message: string): Sql {
  const rejected = Promise.reject(new Error(message));
  rejected.catch(() => {});
  const builder = () => rejected;
  return builder as unknown as Sql;
}

async function getFunnel(handler: ReturnType<typeof createFunnelHandler>, qs: string) {
  const app = new Hono();
  app.get('/funnel', handler);
  return app.request(`/funnel${qs}`);
}

describe('createFunnelHandler (validation & errors)', () => {
  test('missing steps → 400 MISSING_PARAMETER', async () => {
    const res = await getFunnel(createFunnelHandler(rowsSql([])), '');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'MISSING_PARAMETER',
    );
  });

  test('fewer than 2 steps → 400 INVALID_PARAMETER', async () => {
    const res = await getFunnel(createFunnelHandler(rowsSql([])), '?steps=request');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'INVALID_PARAMETER',
    );
  });

  test('more than 10 steps → 400 INVALID_PARAMETER', async () => {
    const steps = Array.from({ length: 11 }, (_, i) => `s${i}`).join(',');
    const res = await getFunnel(createFunnelHandler(rowsSql([])), `?steps=${steps}`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'INVALID_PARAMETER',
    );
  });

  test('bad window → 400 INVALID_PARAMETER', async () => {
    const res = await getFunnel(createFunnelHandler(rowsSql([])), '?steps=a,b&window=0');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'INVALID_PARAMETER',
    );
  });

  test('a query failure → 500 INTERNAL_ERROR', async () => {
    const res = await getFunnel(createFunnelHandler(rejectingSql('db down')), '?steps=a,b');
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INTERNAL_ERROR');
  });

  test('computes per-step counts and conversion rates from the rows', async () => {
    const rows = [
      row('u1', 'request', '2026-03-01T00:00:00Z'),
      row('u1', 'signup', '2026-03-01T01:00:00Z'),
      row('u1', 'clip_created', '2026-03-01T02:00:00Z'),
      row('u2', 'request', '2026-03-01T00:00:00Z'),
      row('u2', 'signup', '2026-03-01T01:00:00Z'),
      row('u3', 'request', '2026-03-01T00:00:00Z'),
      row('u4', 'request', '2026-03-01T00:00:00Z'),
    ];
    const res = await getFunnel(
      createFunnelHandler(rowsSql(rows)),
      '?steps=request,signup,clip_created',
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as FunnelResponse;
    expect(body.steps).toEqual([
      { event_type: 'request', count: 4, conversion_rate: 1.0 },
      { event_type: 'signup', count: 2, conversion_rate: 0.5 },
      { event_type: 'clip_created', count: 1, conversion_rate: 0.5 },
    ]);
    expect(body.overall_conversion).toBe(0.25); // 1 / 4
    expect(body.window_seconds).toBe(86400);
  });

  test('an empty result set yields zero counts and guarded (0) rates', async () => {
    const res = await getFunnel(createFunnelHandler(rowsSql([])), '?steps=a,b,c&window=3600');
    const body = (await res.json()) as FunnelResponse;
    expect(body.steps.map((s) => s.count)).toEqual([0, 0, 0]);
    expect(body.steps.map((s) => s.conversion_rate)).toEqual([1.0, 0, 0]);
    expect(body.overall_conversion).toBe(0);
    expect(body.window_seconds).toBe(3600);
  });

  test('echoes applied product_id and after in filters', async () => {
    const res = await getFunnel(
      createFunnelHandler(rowsSql([])),
      '?steps=a,b&product_id=clipcast&after=2026-03-01T00:00:00Z',
    );
    const body = (await res.json()) as FunnelResponse;
    expect(body.filters.product_id).toBe('clipcast');
    expect(body.filters.after).toBe('2026-03-01T00:00:00.000Z');
  });
});

// ── Integration (live Postgres) ────────────────────────────────────────────

/** Insert one event with an explicit entity (as user_id) and timestamp. */
async function seedEvent(
  sql: Sql,
  e: { product_id: string; event_type: string; user_id: string; timestamp: string },
): Promise<void> {
  await sql`
    INSERT INTO beacon_events (product_id, event_type, user_id, timestamp)
    VALUES (${e.product_id}, ${e.event_type}, ${e.user_id}, ${e.timestamp})`;
}

// A wide common time range so the 30-day default never excludes fixtures.
const RANGE = 'after=2026-01-01T00:00:00Z&before=2027-01-01T00:00:00Z';

describe.skipIf(!TEST_DB)('createFunnelHandler (live Postgres)', () => {
  let sql: Sql;

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

  test('overall_conversion equals last-step / first-step over seeded ordered events', async () => {
    // 3 entities request; 2 sign up; 1 creates a clip — all within 24h.
    const journeys: Array<[string, string[]]> = [
      ['u1', ['request', 'signup', 'clip_created']],
      ['u2', ['request', 'signup']],
      ['u3', ['request']],
    ];
    let hour = 0;
    for (const [user, types] of journeys) {
      for (const type of types) {
        await seedEvent(sql, {
          product_id: 'clipcast',
          event_type: type,
          user_id: user,
          timestamp: `2026-03-01T0${hour++}:00:00Z`,
        });
      }
      hour = 0;
    }

    const app = new Hono();
    app.get('/funnel', createFunnelHandler(sql));
    const res = await app.request(`/funnel?${RANGE}&steps=request,signup,clip_created`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as FunnelResponse;

    expect(body.steps.map((s) => s.count)).toEqual([3, 2, 1]);
    expect(body.steps[1]?.conversion_rate).toBeCloseTo(2 / 3, 10);
    expect(body.steps[2]?.conversion_rate).toBeCloseTo(0.5, 10);
    expect(body.overall_conversion).toBeCloseTo(1 / 3, 10); // last / first
  });

  test('window expiry and step-skip exclusions hold against real SQL', async () => {
    // u1: full chain inside 1h window.
    await seedEvent(sql, {
      product_id: 'p',
      event_type: 'a',
      user_id: 'u1',
      timestamp: '2026-03-01T00:00:00Z',
    });
    await seedEvent(sql, {
      product_id: 'p',
      event_type: 'b',
      user_id: 'u1',
      timestamp: '2026-03-01T00:30:00Z',
    });
    // u2: step b lands after the 3600s window → excluded at step 2.
    await seedEvent(sql, {
      product_id: 'p',
      event_type: 'a',
      user_id: 'u2',
      timestamp: '2026-03-01T00:00:00Z',
    });
    await seedEvent(sql, {
      product_id: 'p',
      event_type: 'b',
      user_id: 'u2',
      timestamp: '2026-03-01T02:00:00Z',
    });
    // u3: only step a.
    await seedEvent(sql, {
      product_id: 'p',
      event_type: 'a',
      user_id: 'u3',
      timestamp: '2026-03-01T00:00:00Z',
    });

    const app = new Hono();
    app.get('/funnel', createFunnelHandler(sql));
    const res = await app.request(`/funnel?${RANGE}&product_id=p&steps=a,b&window=3600`);
    const body = (await res.json()) as FunnelResponse;
    expect(body.steps.map((s) => s.count)).toEqual([3, 1]);
    expect(body.overall_conversion).toBeCloseTo(1 / 3, 10);
  });

  test('product_id filter scopes the funnel to one product', async () => {
    await seedEvent(sql, {
      product_id: 'p1',
      event_type: 'a',
      user_id: 'u1',
      timestamp: '2026-03-01T00:00:00Z',
    });
    await seedEvent(sql, {
      product_id: 'p1',
      event_type: 'b',
      user_id: 'u1',
      timestamp: '2026-03-01T01:00:00Z',
    });
    await seedEvent(sql, {
      product_id: 'p2',
      event_type: 'a',
      user_id: 'u2',
      timestamp: '2026-03-01T00:00:00Z',
    });
    await seedEvent(sql, {
      product_id: 'p2',
      event_type: 'b',
      user_id: 'u2',
      timestamp: '2026-03-01T01:00:00Z',
    });

    const app = new Hono();
    app.get('/funnel', createFunnelHandler(sql));
    const res = await app.request(`/funnel?${RANGE}&product_id=p1&steps=a,b`);
    const body = (await res.json()) as FunnelResponse;
    expect(body.steps.map((s) => s.count)).toEqual([1, 1]);
  });
});
