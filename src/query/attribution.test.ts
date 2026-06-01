import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { Hono } from 'hono';
import type { Sql } from 'postgres';

import { QueryParamError } from '../api/params';
import { closeDb, createDb } from '../storage/db';
import { runMigrations } from '../storage/migrate';
import { createAttributionHandler, parseConversionEvent, parseGroupBy } from './attribution';

const TEST_DB = process.env.TEST_DATABASE_URL;

interface AttributionGroup {
  key: string;
  clicks: number;
  conversions: number;
  conversion_rate: number;
}

interface AttributionResponse {
  group_by: string;
  conversion_event: string;
  groups: AttributionGroup[];
  filters: { product_id?: string; after: string };
}

// ── Pure helpers (no DB) ──────────────────────────────────────────────────

describe('parseGroupBy', () => {
  test('defaults to utm_source when absent or blank', () => {
    expect(parseGroupBy(undefined)).toBe('utm_source');
    expect(parseGroupBy('   ')).toBe('utm_source');
  });

  test('passes through every allowed dimension', () => {
    for (const v of [
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_content',
      'utm_term',
      'channel',
    ] as const) {
      expect(parseGroupBy(v)).toBe(v);
    }
  });

  test('rejects an out-of-set value with QueryParamError', () => {
    expect(() => parseGroupBy('platform')).toThrow(QueryParamError);
    expect(() => parseGroupBy('utm_sourceX')).toThrow(QueryParamError);
  });
});

describe('parseConversionEvent', () => {
  test('defaults to signup when absent or blank', () => {
    expect(parseConversionEvent(undefined)).toBe('signup');
    expect(parseConversionEvent('  ')).toBe('signup');
  });

  test('passes through a supplied event type (trimmed)', () => {
    expect(parseConversionEvent('purchase')).toBe('purchase');
    expect(parseConversionEvent('  clip_created ')).toBe('clip_created');
  });
});

/**
 * A `Sql` stub whose every tagged-template call returns the SAME rejected
 * promise (see events.test.ts for the rationale: the handler composes fragments
 * and discards intermediates, so a fresh rejection per call would surface as an
 * unhandled rejection rather than exercising the catch path).
 */
function rejectingSql(message: string): Sql {
  const rejected = Promise.reject(new Error(message));
  rejected.catch(() => {});
  const builder = () => rejected;
  return builder as unknown as Sql;
}

describe('createAttributionHandler (error isolation)', () => {
  test('a query failure becomes a §5.5 INTERNAL_ERROR 500', async () => {
    const app = new Hono();
    app.get('/attribution', createAttributionHandler(rejectingSql('db down')));
    const res = await app.request('/attribution');
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INTERNAL_ERROR');
  });

  test('an out-of-set group_by is a §5.5 INVALID_PARAMETER 400 (never reaches the DB)', async () => {
    const app = new Hono();
    app.get('/attribution', createAttributionHandler(rejectingSql('should not run')));
    const res = await app.request('/attribution?group_by=platform');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; parameter: string } };
    expect(body.error.code).toBe('INVALID_PARAMETER');
    expect(body.error.parameter).toBe('group_by');
  });
});

// ── Integration (live Postgres) ───────────────────────────────────────────

/** Insert one event with optional attribution JSONB + user_id. */
async function seedEvent(
  sql: Sql,
  row: {
    product_id: string;
    event_type: string;
    timestamp: string;
    user_id?: string | null;
    attribution?: Record<string, string>;
  },
): Promise<void> {
  await sql`
    INSERT INTO beacon_events (product_id, event_type, timestamp, user_id, attribution)
    VALUES (${row.product_id}, ${row.event_type}, ${row.timestamp}, ${row.user_id ?? null},
            ${sql.json(row.attribution ?? {})})`;
}

/** GET /attribution?<qs> through a mounted app; assert 200 and return the body. */
async function getAttribution(
  handler: ReturnType<typeof createAttributionHandler>,
  qs = '',
): Promise<AttributionResponse> {
  const app = new Hono();
  app.get('/attribution', handler);
  const res = await app.request(`/attribution${qs}`);
  expect(res.status).toBe(200);
  return (await res.json()) as AttributionResponse;
}

const WINDOW = 'after=2026-01-01T00:00:00Z&before=2027-01-01T00:00:00Z';

/** Index a groups array by key for order-independent assertions. */
function byKey(groups: AttributionGroup[]): Record<string, AttributionGroup> {
  return Object.fromEntries(groups.map((g) => [g.key, g]));
}

describe.skipIf(!TEST_DB)('createAttributionHandler (live Postgres)', () => {
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

  // AC1: group_by=utm_source groups correctly with correct clicks.
  test('groups by utm_source with correct click counts', async () => {
    await seedEvent(sql, {
      product_id: 'clipcast',
      event_type: 'request',
      timestamp: '2026-03-01T00:00:00Z',
      user_id: 'u1',
      attribution: { utm_source: 'google' },
    });
    await seedEvent(sql, {
      product_id: 'clipcast',
      event_type: 'request',
      timestamp: '2026-03-02T00:00:00Z',
      user_id: 'u2',
      attribution: { utm_source: 'google' },
    });
    await seedEvent(sql, {
      product_id: 'clipcast',
      event_type: 'request',
      timestamp: '2026-03-03T00:00:00Z',
      user_id: 'u3',
      attribution: { utm_source: 'twitter' },
    });

    const body = await getAttribution(createAttributionHandler(sql), `?${WINDOW}`);

    expect(body.group_by).toBe('utm_source');
    expect(body.conversion_event).toBe('signup');
    const groups = byKey(body.groups);
    expect(groups.google?.clicks).toBe(2);
    expect(groups.twitter?.clicks).toBe(1);
  });

  // AC2: conversion count and conversion_rate are correct for seeded conversions.
  test('counts distinct converting users and computes conversion_rate', async () => {
    // google: 3 clicks across u1 (twice) + u2; only u1 converts → 1 conversion.
    await seedEvent(sql, {
      product_id: 'clipcast',
      event_type: 'request',
      timestamp: '2026-03-01T00:00:00Z',
      user_id: 'u1',
      attribution: { utm_source: 'google' },
    });
    await seedEvent(sql, {
      product_id: 'clipcast',
      event_type: 'request',
      timestamp: '2026-03-01T01:00:00Z',
      user_id: 'u1',
      attribution: { utm_source: 'google' },
    });
    await seedEvent(sql, {
      product_id: 'clipcast',
      event_type: 'request',
      timestamp: '2026-03-02T00:00:00Z',
      user_id: 'u2',
      attribution: { utm_source: 'google' },
    });
    // u1's signup also carries the attribution key — it must NOT inflate clicks
    // double-counting is fine for clicks (it's a real attributed event), but the
    // conversion is counted once (DISTINCT user).
    await seedEvent(sql, {
      product_id: 'clipcast',
      event_type: 'signup',
      timestamp: '2026-03-03T00:00:00Z',
      user_id: 'u1',
      attribution: { utm_source: 'google' },
    });

    const body = await getAttribution(createAttributionHandler(sql), `?${WINDOW}`);
    const google = byKey(body.groups).google;
    expect(google?.clicks).toBe(4); // 3 requests + 1 signup, all attributed to google
    expect(google?.conversions).toBe(1); // only u1 converted (distinct user)
    expect(google?.conversion_rate).toBeCloseTo(1 / 4, 10);
  });

  // AC3: group_by=channel maps sources to categories; unknown sources → 'other'.
  test('maps sources to channel categories per channelMapping, unknown → other', async () => {
    const handler = createAttributionHandler(sql, {
      channelMapping: { paid: ['google', 'bing'], social: ['twitter'] },
    });
    await seedEvent(sql, {
      product_id: 'clipcast',
      event_type: 'request',
      timestamp: '2026-03-01T00:00:00Z',
      user_id: 'u1',
      attribution: { utm_source: 'google' },
    });
    await seedEvent(sql, {
      product_id: 'clipcast',
      event_type: 'request',
      timestamp: '2026-03-02T00:00:00Z',
      user_id: 'u2',
      attribution: { utm_source: 'bing' },
    });
    await seedEvent(sql, {
      product_id: 'clipcast',
      event_type: 'request',
      timestamp: '2026-03-03T00:00:00Z',
      user_id: 'u3',
      attribution: { utm_source: 'twitter' },
    });
    await seedEvent(sql, {
      product_id: 'clipcast',
      event_type: 'request',
      timestamp: '2026-03-04T00:00:00Z',
      user_id: 'u4',
      attribution: { utm_source: 'reddit' }, // unmapped → other
    });

    const body = await getAttribution(handler, `?${WINDOW}&group_by=channel`);
    expect(body.group_by).toBe('channel');
    const groups = byKey(body.groups);
    expect(groups.paid?.clicks).toBe(2); // google + bing
    expect(groups.social?.clicks).toBe(1); // twitter
    expect(groups.other?.clicks).toBe(1); // reddit
  });

  // AC4: events without attribution data are excluded entirely.
  test('excludes events that lack the grouping attribution key', async () => {
    await seedEvent(sql, {
      product_id: 'clipcast',
      event_type: 'request',
      timestamp: '2026-03-01T00:00:00Z',
      user_id: 'u1',
      attribution: { utm_source: 'google' },
    });
    // No attribution at all.
    await seedEvent(sql, {
      product_id: 'clipcast',
      event_type: 'request',
      timestamp: '2026-03-02T00:00:00Z',
      user_id: 'u2',
    });
    // Attribution present but lacking utm_source (the grouping key).
    await seedEvent(sql, {
      product_id: 'clipcast',
      event_type: 'request',
      timestamp: '2026-03-03T00:00:00Z',
      user_id: 'u3',
      attribution: { utm_medium: 'cpc' },
    });

    const body = await getAttribution(createAttributionHandler(sql), `?${WINDOW}`);
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0]?.key).toBe('google');
    expect(body.groups[0]?.clicks).toBe(1);
  });

  // AC6: full E2E across a multi-source fixture — clicks + conversions match.
  test('E2E: a multi-source fixture yields the expected grouped clicks/conversions', async () => {
    const fixture: { user_id: string; source: string; converts: boolean }[] = [
      { user_id: 'a', source: 'google', converts: true },
      { user_id: 'b', source: 'google', converts: true },
      { user_id: 'c', source: 'google', converts: false },
      { user_id: 'd', source: 'twitter', converts: true },
      { user_id: 'e', source: 'twitter', converts: false },
    ];
    let day = 1;
    for (const f of fixture) {
      await seedEvent(sql, {
        product_id: 'clipcast',
        event_type: 'request',
        timestamp: `2026-03-0${day}T00:00:00Z`,
        user_id: f.user_id,
        attribution: { utm_source: f.source },
      });
      if (f.converts) {
        await seedEvent(sql, {
          product_id: 'clipcast',
          event_type: 'signup',
          timestamp: `2026-03-0${day}T01:00:00Z`,
          user_id: f.user_id,
          attribution: { utm_source: f.source },
        });
      }
      day++;
    }

    const body = await getAttribution(
      createAttributionHandler(sql),
      `?${WINDOW}&product_id=clipcast`,
    );
    const groups = byKey(body.groups);
    // google: 3 requests + 2 signups = 5 clicks; 2 distinct converters.
    expect(groups.google?.clicks).toBe(5);
    expect(groups.google?.conversions).toBe(2);
    expect(groups.google?.conversion_rate).toBeCloseTo(2 / 5, 10);
    // twitter: 2 requests + 1 signup = 3 clicks; 1 distinct converter.
    expect(groups.twitter?.clicks).toBe(3);
    expect(groups.twitter?.conversions).toBe(1);
    expect(groups.twitter?.conversion_rate).toBeCloseTo(1 / 3, 10);
    // filters echo applied product_id + after.
    expect(body.filters.product_id).toBe('clipcast');
    expect(body.filters.after).toBe('2026-01-01T00:00:00.000Z');
    // groups ordered by clicks DESC.
    expect(body.groups.map((g) => g.key)).toEqual(['google', 'twitter']);
  });

  test('a conversion outside the time range does not count', async () => {
    await seedEvent(sql, {
      product_id: 'clipcast',
      event_type: 'request',
      timestamp: '2026-03-01T00:00:00Z',
      user_id: 'u1',
      attribution: { utm_source: 'google' },
    });
    // Signup is in 2025 — outside the WINDOW.
    await seedEvent(sql, {
      product_id: 'clipcast',
      event_type: 'signup',
      timestamp: '2025-06-01T00:00:00Z',
      user_id: 'u1',
      attribution: { utm_source: 'google' },
    });

    const body = await getAttribution(createAttributionHandler(sql), `?${WINDOW}`);
    expect(byKey(body.groups).google?.conversions).toBe(0);
  });

  // Locks in the §5.4 attribution model: a user is attributed by their CLICK
  // (the event carrying the UTM key), so a conversion counts even when the
  // conversion event itself carries no attribution params — as real signups
  // typically don't. Guards against a future "tighten the converters filter".
  test('counts a conversion whose event carries no attribution key', async () => {
    await seedEvent(sql, {
      product_id: 'clipcast',
      event_type: 'request',
      timestamp: '2026-03-01T00:00:00Z',
      user_id: 'u1',
      attribution: { utm_source: 'google' }, // the click carries the key
    });
    // The signup has NO attribution at all — yet u1 is already attributed to
    // google by the click above, so this must still count as a conversion.
    await seedEvent(sql, {
      product_id: 'clipcast',
      event_type: 'signup',
      timestamp: '2026-03-02T00:00:00Z',
      user_id: 'u1',
    });

    const body = await getAttribution(createAttributionHandler(sql), `?${WINDOW}`);
    const google = byKey(body.groups).google;
    expect(google?.clicks).toBe(1); // only the request — the bare signup lacks the key
    expect(google?.conversions).toBe(1);
    expect(google?.conversion_rate).toBeCloseTo(1, 10);
  });

  test('with no channelMapping every attributed source falls into other', async () => {
    await seedEvent(sql, {
      product_id: 'clipcast',
      event_type: 'request',
      timestamp: '2026-03-01T00:00:00Z',
      user_id: 'u1',
      attribution: { utm_source: 'google' },
    });
    await seedEvent(sql, {
      product_id: 'clipcast',
      event_type: 'request',
      timestamp: '2026-03-02T00:00:00Z',
      user_id: 'u2',
      attribution: { utm_source: 'twitter' },
    });

    const body = await getAttribution(createAttributionHandler(sql), `?${WINDOW}&group_by=channel`);
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0]?.key).toBe('other');
    expect(body.groups[0]?.clicks).toBe(2);
  });
});
