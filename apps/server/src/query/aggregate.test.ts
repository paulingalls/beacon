import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { Sql } from 'postgres';
import { registerDbCoverageGuard, TEST_DB } from '../../test/dbGuard';
import { QueryParamError } from '../api/params';
import { closeDb, createDb } from '../storage/db';
import { runMigrations } from '../storage/migrate';
import { createAggregateHandler, parseGroupBy, parseMetric } from './aggregate';

registerDbCoverageGuard();

// ── Pure helpers (no DB) ──────────────────────────────────────────────────

describe('parseMetric', () => {
  test('defaults to count when absent or blank', () => {
    expect(parseMetric(undefined)).toBe('count');
    expect(parseMetric('  ')).toBe('count');
  });

  test('passes through each allowed metric', () => {
    expect(parseMetric('count')).toBe('count');
    expect(parseMetric('unique_users')).toBe('unique_users');
    expect(parseMetric('unique_visitors')).toBe('unique_visitors');
  });

  test('rejects an unknown metric with QueryParamError', () => {
    expect(() => parseMetric('sum')).toThrow(QueryParamError);
    expect(() => parseMetric('COUNT')).toThrow(QueryParamError);
  });
});

describe('parseGroupBy', () => {
  test('returns null when absent or blank', () => {
    expect(parseGroupBy(undefined)).toBeNull();
    expect(parseGroupBy('   ')).toBeNull();
  });

  test('recognises each whitelisted dimension', () => {
    for (const dim of [
      'product_id',
      'event_type',
      'platform',
      'user_id',
      'visitor_token',
    ] as const) {
      expect(parseGroupBy(dim)).toEqual({ kind: 'dimension', value: dim });
    }
  });

  test('recognises each whitelisted time bucket', () => {
    for (const unit of ['day', 'hour', 'week', 'month'] as const) {
      expect(parseGroupBy(unit)).toEqual({ kind: 'time', value: unit });
    }
  });

  test('rejects anything off the whitelist with QueryParamError', () => {
    expect(() => parseGroupBy('properties')).toThrow(QueryParamError);
    expect(() => parseGroupBy('timestamp')).toThrow(QueryParamError);
    expect(() => parseGroupBy('year')).toThrow(QueryParamError);
  });
});

/**
 * A `Sql` stub whose every tagged-template call returns the SAME rejected
 * promise. The handler composes fragments and discards each intermediate before
 * its single `await`; reusing one pre-handled rejection keeps the await
 * rejecting while silencing the discards (mirrors events.test.ts).
 */
function rejectingSql(message: string): Sql {
  const rejected = Promise.reject(new Error(message));
  rejected.catch(() => {});
  const builder = () => rejected;
  return builder as unknown as Sql;
}

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

describe('createAggregateHandler (param validation + error isolation)', () => {
  test('a query failure becomes a §5.5 INTERNAL_ERROR 500', async () => {
    const app = new Hono();
    app.get('/aggregate', createAggregateHandler(rejectingSql('db down')));
    const res = await app.request('/aggregate');
    expect(res.status).toBe(500);
    expect(await errorCode(res)).toBe('INTERNAL_ERROR');
  });

  test('an invalid metric is a 400 INVALID_PARAMETER before any DB call', async () => {
    const app = new Hono();
    app.get('/aggregate', createAggregateHandler(rejectingSql('should not run')));
    const res = await app.request('/aggregate?metric=sum');
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('INVALID_PARAMETER');
  });

  test('an invalid group_by is a 400 INVALID_PARAMETER before any DB call', async () => {
    const app = new Hono();
    app.get('/aggregate', createAggregateHandler(rejectingSql('should not run')));
    const res = await app.request('/aggregate?group_by=properties');
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('INVALID_PARAMETER');
  });

  test('a bad common param (reversed range) is a 400 INVALID_PARAMETER', async () => {
    const app = new Hono();
    app.get('/aggregate', createAggregateHandler(rejectingSql('should not run')));
    const res = await app.request(
      '/aggregate?after=2027-01-01T00:00:00Z&before=2026-01-01T00:00:00Z',
    );
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('INVALID_PARAMETER');
  });
});

// ── Integration (live Postgres) ───────────────────────────────────────────

interface AggregateResponse {
  metric: string;
  value?: number;
  group_by?: string;
  groups?: { key: string | null; value: number }[];
  filters: { product_id?: string; after: string };
}

/** Insert one event. */
async function seedEvent(
  sql: Sql,
  row: {
    product_id: string;
    event_type: string;
    timestamp: string;
    platform?: string;
    user_id?: string | null;
    visitor_token?: string | null;
  },
): Promise<void> {
  await sql`
    INSERT INTO beacon_events
      (product_id, event_type, timestamp, platform, user_id, visitor_token)
    VALUES (${row.product_id}, ${row.event_type}, ${row.timestamp}, ${row.platform ?? 'web'},
            ${row.user_id ?? null}, ${row.visitor_token ?? null})`;
}

/** GET /aggregate?<qs> through a mounted app; assert 200 and return the body. */
async function getAggregate(
  handler: ReturnType<typeof createAggregateHandler>,
  qs = '',
): Promise<AggregateResponse> {
  const app = new Hono();
  app.get('/aggregate', handler);
  const res = await app.request(`/aggregate${qs}`);
  expect(res.status).toBe(200);
  return (await res.json()) as AggregateResponse;
}

// A wide window so the 30-day default never excludes the seeded fixtures.
const WINDOW = 'after=2026-01-01T00:00:00Z&before=2027-01-01T00:00:00Z';

describe.skipIf(!TEST_DB)('createAggregateHandler (live Postgres)', () => {
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

  test('ungrouped count returns the seeded total and echoes filters', async () => {
    for (let d = 1; d <= 3; d++) {
      await seedEvent(sql, {
        product_id: 'clipcast',
        event_type: 'request',
        timestamp: `2026-03-0${d}T00:00:00Z`,
      });
    }

    const body = await getAggregate(createAggregateHandler(sql), `?${WINDOW}&product_id=clipcast`);

    expect(body.metric).toBe('count');
    expect(body.value).toBe(3);
    expect(body.groups).toBeUndefined();
    expect(body.filters.product_id).toBe('clipcast');
    expect(body.filters.after).toBe('2026-01-01T00:00:00.000Z');
  });

  test('unique_users excludes anonymous (null user_id) events', async () => {
    await seedEvent(sql, {
      product_id: 'clipcast',
      event_type: 'request',
      timestamp: '2026-03-01T00:00:00Z',
      user_id: 'u1',
    });
    await seedEvent(sql, {
      product_id: 'clipcast',
      event_type: 'request',
      timestamp: '2026-03-02T00:00:00Z',
      user_id: 'u1',
    });
    await seedEvent(sql, {
      product_id: 'clipcast',
      event_type: 'request',
      timestamp: '2026-03-03T00:00:00Z',
      user_id: 'u2',
    });
    await seedEvent(sql, {
      product_id: 'clipcast',
      event_type: 'request',
      timestamp: '2026-03-04T00:00:00Z',
      user_id: null,
    });

    const body = await getAggregate(createAggregateHandler(sql), `?${WINDOW}&metric=unique_users`);

    expect(body.metric).toBe('unique_users');
    expect(body.value).toBe(2); // u1, u2 — anonymous row excluded
  });

  test('unique_visitors dedups across COALESCE(user_id, visitor_token)', async () => {
    // u1 authed on two visitor tokens → one unique visitor.
    await seedEvent(sql, {
      product_id: 'clipcast',
      event_type: 'request',
      timestamp: '2026-03-01T00:00:00Z',
      user_id: 'u1',
      visitor_token: 'vt_a',
    });
    await seedEvent(sql, {
      product_id: 'clipcast',
      event_type: 'request',
      timestamp: '2026-03-02T00:00:00Z',
      user_id: 'u1',
      visitor_token: 'vt_b',
    });
    // anonymous visitor on its own token → second unique visitor.
    await seedEvent(sql, {
      product_id: 'clipcast',
      event_type: 'request',
      timestamp: '2026-03-03T00:00:00Z',
      user_id: null,
      visitor_token: 'vt_c',
    });
    // same anonymous token again → still the second visitor.
    await seedEvent(sql, {
      product_id: 'clipcast',
      event_type: 'request',
      timestamp: '2026-03-04T00:00:00Z',
      user_id: null,
      visitor_token: 'vt_c',
    });

    const body = await getAggregate(
      createAggregateHandler(sql),
      `?${WINDOW}&metric=unique_visitors`,
    );

    expect(body.value).toBe(2);
  });

  test('group_by=day returns date_trunc buckets in chronological order', async () => {
    await seedEvent(sql, {
      product_id: 'clipcast',
      event_type: 'request',
      timestamp: '2026-03-02T05:00:00Z',
    });
    await seedEvent(sql, {
      product_id: 'clipcast',
      event_type: 'request',
      timestamp: '2026-03-02T18:00:00Z',
    });
    await seedEvent(sql, {
      product_id: 'clipcast',
      event_type: 'request',
      timestamp: '2026-03-01T12:00:00Z',
    });

    const body = await getAggregate(createAggregateHandler(sql), `?${WINDOW}&group_by=day`);

    expect(body.group_by).toBe('day');
    expect(body.groups).toEqual([
      { key: '2026-03-01T00:00:00.000Z', value: 1 },
      { key: '2026-03-02T00:00:00.000Z', value: 2 },
    ]);
  });

  test('group_by=platform returns groups sorted by value descending', async () => {
    await seedEvent(sql, {
      product_id: 'clipcast',
      event_type: 'request',
      timestamp: '2026-03-01T00:00:00Z',
      platform: 'web',
    });
    await seedEvent(sql, {
      product_id: 'clipcast',
      event_type: 'request',
      timestamp: '2026-03-02T00:00:00Z',
      platform: 'web',
    });
    await seedEvent(sql, {
      product_id: 'clipcast',
      event_type: 'request',
      timestamp: '2026-03-03T00:00:00Z',
      platform: 'web',
    });
    await seedEvent(sql, {
      product_id: 'clipcast',
      event_type: 'request',
      timestamp: '2026-03-04T00:00:00Z',
      platform: 'ios',
    });

    const body = await getAggregate(createAggregateHandler(sql), `?${WINDOW}&group_by=platform`);

    expect(body.group_by).toBe('platform');
    expect(body.groups).toEqual([
      { key: 'web', value: 3 },
      { key: 'ios', value: 1 },
    ]);
  });

  // Groups tied on value break by key ascending, so the LIMIT-100 truncation is
  // deterministic rather than arbitrary run-to-run (close-review 8492f5d8988f).
  test('group_by breaks value ties deterministically by key', async () => {
    for (const platform of ['ios', 'android']) {
      for (const day of ['01', '02']) {
        await seedEvent(sql, {
          product_id: 'clipcast',
          event_type: 'request',
          timestamp: `2026-03-${day}T00:00:00Z`,
          platform,
        });
      }
    }

    const body = await getAggregate(createAggregateHandler(sql), `?${WINDOW}&group_by=platform`);
    // Both have value 2; the tiebreak orders them by key ascending.
    expect(body.groups).toEqual([
      { key: 'android', value: 2 },
      { key: 'ios', value: 2 },
    ]);
  });

  test('applies the common filters (product_id, platform, user_id, event_type, time range)', async () => {
    // One row matches everything; each other row breaks exactly one filter.
    await seedEvent(sql, {
      product_id: 'clipcast',
      event_type: 'signup',
      timestamp: '2026-03-04T00:00:00Z',
      platform: 'ios',
      user_id: 'um',
    });
    await seedEvent(sql, {
      product_id: 'divine-ruin',
      event_type: 'signup',
      timestamp: '2026-03-04T00:00:00Z',
      platform: 'ios',
      user_id: 'um',
    }); // product
    await seedEvent(sql, {
      product_id: 'clipcast',
      event_type: 'request',
      timestamp: '2026-03-04T00:00:00Z',
      platform: 'ios',
      user_id: 'um',
    }); // event_type
    await seedEvent(sql, {
      product_id: 'clipcast',
      event_type: 'signup',
      timestamp: '2026-03-04T00:00:00Z',
      platform: 'web',
      user_id: 'um',
    }); // platform
    await seedEvent(sql, {
      product_id: 'clipcast',
      event_type: 'signup',
      timestamp: '2026-03-04T00:00:00Z',
      platform: 'ios',
      user_id: 'uo',
    }); // user
    await seedEvent(sql, {
      product_id: 'clipcast',
      event_type: 'signup',
      timestamp: '2025-06-01T00:00:00Z',
      platform: 'ios',
      user_id: 'um',
    }); // time

    const body = await getAggregate(
      createAggregateHandler(sql),
      `?${WINDOW}&product_id=clipcast&platform=ios&user_id=um&event_type=signup`,
    );

    expect(body.value).toBe(1);
  });

  test('an empty result returns value 0 (ungrouped) and [] (grouped)', async () => {
    const ungrouped = await getAggregate(createAggregateHandler(sql), `?${WINDOW}`);
    expect(ungrouped.value).toBe(0);

    const grouped = await getAggregate(createAggregateHandler(sql), `?${WINDOW}&group_by=platform`);
    expect(grouped.groups).toEqual([]);
  });
});
