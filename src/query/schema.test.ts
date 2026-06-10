import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { Sql } from 'postgres';
import { registerDbCoverageGuard, TEST_DB } from '../../test/dbGuard';

import { closeDb, createDb } from '../storage/db';
import { runMigrations } from '../storage/migrate';
import { createSchemaHandler } from './schema';

registerDbCoverageGuard();

/** Insert a beacon_events row with explicit timestamp/platform/properties. */
async function seedEvent(
  sql: Sql,
  row: {
    product_id: string;
    event_type: string;
    timestamp: string;
    platform: string;
    properties: Record<string, unknown>;
  },
): Promise<void> {
  await sql`
    INSERT INTO beacon_events (product_id, event_type, timestamp, platform, properties)
    VALUES (${row.product_id}, ${row.event_type}, ${row.timestamp}, ${row.platform},
            ${sql.json(row.properties as Parameters<Sql['json']>[0])})`;
}

/**
 * Insert a beacon_meta row with explicit first_seen/last_seen/count. The buffer
 * never writes first_seen (column DEFAULT only), so the test must set it to get
 * a deterministic, non-wall-clock-flaky assertion (see story-002 plan).
 */
async function seedMeta(
  sql: Sql,
  row: {
    product_id: string;
    event_type: string;
    first_seen: string;
    last_seen: string;
    count: number;
  },
): Promise<void> {
  await sql`
    INSERT INTO beacon_meta (product_id, event_type, first_seen, last_seen, count)
    VALUES (${row.product_id}, ${row.event_type}, ${row.first_seen}, ${row.last_seen}, ${row.count})`;
}

/** GET /schema through a tiny mounted app and return the parsed JSON body. */
async function getSchema(handler: ReturnType<typeof createSchemaHandler>): Promise<SchemaResponse> {
  const app = new Hono();
  app.get('/schema', handler);
  const res = await app.request('/schema');
  expect(res.status).toBe(200);
  return (await res.json()) as SchemaResponse;
}

interface SchemaResponse {
  products: string[];
  event_types: Array<{
    product_id: string;
    event_type: string;
    first_seen: string;
    last_seen: string;
    count: number;
  }>;
  platforms: string[];
  dimensions: string[];
  property_keys: Record<string, Record<string, string[]>>;
  time_range: { earliest: string | null; latest: string | null };
  endpoints: Record<string, { method: string; path: string; description: string }>;
}

describe('createSchemaHandler (error isolation)', () => {
  test('a query failure becomes a §5.5 INTERNAL_ERROR 500, not a thrown crash', async () => {
    // A Sql whose every tagged-template call rejects, exercising the handler's
    // catch path without a live DB (mirrors db.ts's reject-on-query stub).
    const failingSql = (() => Promise.reject(new Error('db down'))) as unknown as Parameters<
      typeof createSchemaHandler
    >[0];

    const app = new Hono();
    app.get('/schema', createSchemaHandler(failingSql, { basePath: '/analytics' }));
    const res = await app.request('/schema');

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INTERNAL_ERROR');
  });
});

describe.skipIf(!TEST_DB)('createSchemaHandler (live Postgres)', () => {
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

  test('lists products and event types with their beacon_meta counts', async () => {
    await seedMeta(sql, {
      product_id: 'clipcast',
      event_type: 'request',
      first_seen: '2026-03-01T00:00:00Z',
      last_seen: '2026-04-01T00:00:00Z',
      count: 42,
    });
    await seedMeta(sql, {
      product_id: 'divine-ruin',
      event_type: 'signup',
      first_seen: '2026-03-15T00:00:00Z',
      last_seen: '2026-03-20T00:00:00Z',
      count: 7,
    });

    const body = await getSchema(createSchemaHandler(sql, { basePath: '/analytics' }));

    expect(body.products.sort()).toEqual(['clipcast', 'divine-ruin']);
    const clip = body.event_types.find(
      (e) => e.product_id === 'clipcast' && e.event_type === 'request',
    );
    expect(clip?.count).toBe(42);
    expect(clip?.first_seen).toBe('2026-03-01T00:00:00.000Z');
    expect(clip?.last_seen).toBe('2026-04-01T00:00:00.000Z');
  });

  test('property_keys reflect the distinct JSONB keys per (product, event_type)', async () => {
    await seedEvent(sql, {
      product_id: 'clipcast',
      event_type: 'clip_created',
      timestamp: '2026-03-10T00:00:00Z',
      platform: 'web',
      properties: { a: 1, b: 2 },
    });

    const body = await getSchema(createSchemaHandler(sql, { basePath: '/analytics' }));

    expect(body.property_keys.clipcast?.clip_created?.sort()).toEqual(['a', 'b']);
  });

  test('platforms are the DISTINCT platforms present, time_range spans min/max event time', async () => {
    await seedEvent(sql, {
      product_id: 'clipcast',
      event_type: 'request',
      timestamp: '2026-03-01T00:00:00Z',
      platform: 'web',
      properties: {},
    });
    await seedEvent(sql, {
      product_id: 'clipcast',
      event_type: 'request',
      timestamp: '2026-04-04T12:00:00Z',
      platform: 'ios',
      properties: {},
    });

    const body = await getSchema(createSchemaHandler(sql, { basePath: '/analytics' }));

    expect(body.platforms.sort()).toEqual(['ios', 'web']);
    expect(body.time_range.earliest).toBe('2026-03-01T00:00:00.000Z');
    expect(body.time_range.latest).toBe('2026-04-04T12:00:00.000Z');
  });

  test('endpoints descriptor names the four query endpoints with basePath-prefixed paths', async () => {
    const body = await getSchema(createSchemaHandler(sql, { basePath: '/analytics' }));

    expect(Object.keys(body.endpoints).sort()).toEqual([
      'aggregate',
      'attribution',
      'events',
      'funnel',
    ]);
    expect(body.endpoints.events?.path).toBe('/analytics/events');
    expect(body.endpoints.events?.method).toBe('GET');
    expect(body.dimensions).toContain('visitor_token');
  });

  test('an empty database yields empty lists and null time_range bounds', async () => {
    const body = await getSchema(createSchemaHandler(sql, { basePath: '/analytics' }));

    expect(body.products).toEqual([]);
    expect(body.event_types).toEqual([]);
    expect(body.platforms).toEqual([]);
    expect(body.property_keys).toEqual({});
    expect(body.time_range).toEqual({ earliest: null, latest: null });
  });

  test('property_keys are cached: a new key is invisible until the TTL elapses', async () => {
    let clock = 1_000_000;
    const handler = createSchemaHandler(sql, {
      basePath: '/analytics',
      propertyKeysTtlMs: 600_000,
      now: () => clock,
    });

    await seedEvent(sql, {
      product_id: 'clipcast',
      event_type: 'clip_created',
      timestamp: '2026-03-10T00:00:00Z',
      platform: 'web',
      properties: { a: 1 },
    });

    // First call warms the cache with {a}.
    let body = await getSchema(handler);
    expect(body.property_keys.clipcast?.clip_created?.sort()).toEqual(['a']);

    // A new key lands, but within the TTL window the cache still serves {a}.
    await seedEvent(sql, {
      product_id: 'clipcast',
      event_type: 'clip_created',
      timestamp: '2026-03-11T00:00:00Z',
      platform: 'web',
      properties: { z: 9 },
    });
    clock += 599_000; // still inside the 10-minute window
    body = await getSchema(handler);
    expect(body.property_keys.clipcast?.clip_created?.sort()).toEqual(['a']);

    // Past the TTL, the cache refreshes and now sees {a, z}.
    clock += 2_000; // total +601s > 600s TTL
    body = await getSchema(handler);
    expect(body.property_keys.clipcast?.clip_created?.sort()).toEqual(['a', 'z']);
  });
});
