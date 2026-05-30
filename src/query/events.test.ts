import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { Hono } from 'hono';
import type { Sql } from 'postgres';

import { QueryParamError } from '../api/params';
import { closeDb, createDb } from '../storage/db';
import { runMigrations } from '../storage/migrate';
import { createEventsHandler, decodeCursor, encodeCursor, parseLimit } from './events';

const TEST_DB = process.env.TEST_DATABASE_URL;

interface EventRow {
  event_id: string;
  product_id: string;
  timestamp: string;
  event_type: string;
  user_id: string | null;
  platform: string;
  properties: Record<string, unknown>;
  context: Record<string, unknown>;
  attribution: Record<string, unknown>;
}

interface EventsResponse {
  events: EventRow[];
  cursor: string | null;
  has_more: boolean;
}

// ── Pure helpers (no DB) ──────────────────────────────────────────────────

describe('parseLimit', () => {
  test('defaults to 100 when absent', () => {
    expect(parseLimit(undefined)).toBe(100);
  });

  test('passes through an in-range value', () => {
    expect(parseLimit('25')).toBe(25);
  });

  test('clamps a value above 1000 to 1000', () => {
    expect(parseLimit('5000')).toBe(1000);
  });

  test('rejects zero, negative, and non-integer values', () => {
    expect(() => parseLimit('0')).toThrow(QueryParamError);
    expect(() => parseLimit('-1')).toThrow(QueryParamError);
    expect(() => parseLimit('abc')).toThrow(QueryParamError);
    expect(() => parseLimit('1.5')).toThrow(QueryParamError);
  });
});

describe('cursor codec', () => {
  test('encode→decode round-trips the timestamp and id', () => {
    const t = '2026-04-04T10:30:00.000Z';
    const id = '550e8400-e29b-41d4-a716-446655440000';
    const decoded = decodeCursor(encodeCursor(t, id));
    expect(decoded).toEqual({ t, id });
  });

  test('rejects malformed base64 / JSON / missing fields', () => {
    expect(() => decodeCursor('not-base64!!')).toThrow(QueryParamError);
    expect(() => decodeCursor(Buffer.from('not json').toString('base64'))).toThrow(QueryParamError);
    expect(() => decodeCursor(Buffer.from('{"t":"x"}').toString('base64'))).toThrow(
      QueryParamError,
    );
  });
});

/**
 * A `Sql` stub whose every tagged-template call returns the SAME rejected
 * promise. The handler composes fragments (`q = sql`${q} AND ...`) and discards
 * each intermediate before its single `await`; a fresh `Promise.reject()` per
 * call would leave those intermediates as unhandled rejections that fail the
 * test under Bun without exercising the handler's catch path. Reusing one
 * pre-handled rejection keeps the await rejecting while silencing the discards.
 */
function rejectingSql(message: string): Sql {
  const rejected = Promise.reject(new Error(message));
  rejected.catch(() => {}); // mark handled so discarded copies don't warn
  const builder = () => rejected;
  return builder as unknown as Sql;
}

describe('createEventsHandler (error isolation)', () => {
  test('a query failure becomes a §5.5 INTERNAL_ERROR 500', async () => {
    const app = new Hono();
    app.get('/events', createEventsHandler(rejectingSql('db down')));
    const res = await app.request('/events');
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INTERNAL_ERROR');
  });

  test('a malformed cursor is a §5.5 INVALID_PARAMETER 400 (never reaches the DB)', async () => {
    const app = new Hono();
    app.get('/events', createEventsHandler(rejectingSql('should not run')));
    const res = await app.request('/events?cursor=not-base64!!');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'INVALID_PARAMETER',
    );
  });
});

// ── Integration (live Postgres) ───────────────────────────────────────────

/** Insert one event, returning its generated event_id. */
async function seedEvent(
  sql: Sql,
  row: {
    product_id: string;
    event_type: string;
    timestamp: string;
    platform?: string;
    user_id?: string | null;
  },
): Promise<string> {
  const [r] = await sql<{ event_id: string }[]>`
    INSERT INTO beacon_events (product_id, event_type, timestamp, platform, user_id)
    VALUES (${row.product_id}, ${row.event_type}, ${row.timestamp}, ${row.platform ?? 'web'},
            ${row.user_id ?? null})
    RETURNING event_id`;
  return (r as { event_id: string }).event_id;
}

/** GET /events?<qs> through a mounted app; assert 200 and return the body. */
async function getEvents(
  handler: ReturnType<typeof createEventsHandler>,
  qs = '',
): Promise<EventsResponse> {
  const app = new Hono();
  app.get('/events', handler);
  const res = await app.request(`/events${qs}`);
  expect(res.status).toBe(200);
  return (await res.json()) as EventsResponse;
}

// A wide window so the 30-day default never excludes the seeded fixtures.
const WINDOW = 'after=2026-01-01T00:00:00Z&before=2027-01-01T00:00:00Z';

describe.skipIf(!TEST_DB)('createEventsHandler (live Postgres)', () => {
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

  test('filters by event_type and returns matches newest-first', async () => {
    await seedEvent(sql, {
      product_id: 'clipcast',
      event_type: 'request',
      timestamp: '2026-03-01T00:00:00Z',
    });
    await seedEvent(sql, {
      product_id: 'clipcast',
      event_type: 'signup',
      timestamp: '2026-03-02T00:00:00Z',
    });
    await seedEvent(sql, {
      product_id: 'clipcast',
      event_type: 'signup',
      timestamp: '2026-03-03T00:00:00Z',
    });

    const body = await getEvents(createEventsHandler(sql), `?${WINDOW}&event_type=signup`);

    expect(body.events.map((e) => e.event_type)).toEqual(['signup', 'signup']);
    expect(body.events[0]?.timestamp).toBe('2026-03-03T00:00:00.000Z'); // newest first
    expect(body.has_more).toBe(false);
  });

  test('applies the §5.3 common filters (product_id, platform, user_id)', async () => {
    // One row matches all three filters; each other row breaks exactly one.
    const match = await seedEvent(sql, {
      product_id: 'clipcast',
      event_type: 'request',
      timestamp: '2026-03-04T00:00:00Z',
      platform: 'ios',
      user_id: 'user_match',
    });
    await seedEvent(sql, {
      product_id: 'divine-ruin', // wrong product
      event_type: 'request',
      timestamp: '2026-03-03T00:00:00Z',
      platform: 'ios',
      user_id: 'user_match',
    });
    await seedEvent(sql, {
      product_id: 'clipcast',
      event_type: 'request',
      timestamp: '2026-03-02T00:00:00Z',
      platform: 'web', // wrong platform
      user_id: 'user_match',
    });
    await seedEvent(sql, {
      product_id: 'clipcast',
      event_type: 'request',
      timestamp: '2026-03-01T00:00:00Z',
      platform: 'ios',
      user_id: 'user_other', // wrong user
    });

    const body = await getEvents(
      createEventsHandler(sql),
      `?${WINDOW}&product_id=clipcast&platform=ios&user_id=user_match`,
    );

    expect(body.events.map((e) => e.event_id)).toEqual([match]);
  });

  test('paginates with a cursor: page 2 continues with no overlap or gap, then terminates', async () => {
    for (let d = 1; d <= 5; d++) {
      await seedEvent(sql, {
        product_id: 'clipcast',
        event_type: 'request',
        timestamp: `2026-03-0${d}T00:00:00Z`,
      });
    }

    const page1 = await getEvents(createEventsHandler(sql), `?${WINDOW}&limit=2`);
    expect(page1.events).toHaveLength(2);
    expect(page1.has_more).toBe(true);
    expect(page1.cursor).not.toBeNull();
    // Newest two: 03-05, 03-04.
    expect(page1.events.map((e) => e.timestamp)).toEqual([
      '2026-03-05T00:00:00.000Z',
      '2026-03-04T00:00:00.000Z',
    ]);

    const page2 = await getEvents(
      createEventsHandler(sql),
      `?${WINDOW}&limit=2&cursor=${encodeURIComponent(page1.cursor as string)}`,
    );
    expect(page2.events.map((e) => e.timestamp)).toEqual([
      '2026-03-03T00:00:00.000Z',
      '2026-03-02T00:00:00.000Z',
    ]);
    expect(page2.has_more).toBe(true);

    const page3 = await getEvents(
      createEventsHandler(sql),
      `?${WINDOW}&limit=2&cursor=${encodeURIComponent(page2.cursor as string)}`,
    );
    expect(page3.events.map((e) => e.timestamp)).toEqual(['2026-03-01T00:00:00.000Z']);
    expect(page3.has_more).toBe(false);
    expect(page3.cursor).toBeNull();
  });

  test('the event_id tiebreaker splits same-timestamp rows across a page boundary', async () => {
    const ts = '2026-03-10T00:00:00Z';
    const ids = [
      await seedEvent(sql, { product_id: 'clipcast', event_type: 'request', timestamp: ts }),
      await seedEvent(sql, { product_id: 'clipcast', event_type: 'request', timestamp: ts }),
      await seedEvent(sql, { product_id: 'clipcast', event_type: 'request', timestamp: ts }),
    ];

    const page1 = await getEvents(createEventsHandler(sql), `?${WINDOW}&limit=2`);
    const page2 = await getEvents(
      createEventsHandler(sql),
      `?${WINDOW}&limit=2&cursor=${encodeURIComponent(page1.cursor as string)}`,
    );

    const seen = [...page1.events, ...page2.events].map((e) => e.event_id);
    expect(new Set(seen).size).toBe(3); // all three, no dup, no skip
    expect(seen.sort()).toEqual([...ids].sort());
  });

  test('an empty result returns [] with has_more false and a null cursor', async () => {
    const body = await getEvents(createEventsHandler(sql), `?${WINDOW}`);
    expect(body.events).toEqual([]);
    expect(body.has_more).toBe(false);
    expect(body.cursor).toBeNull();
  });

  test('limit above 1000 is capped (no error)', async () => {
    await seedEvent(sql, {
      product_id: 'clipcast',
      event_type: 'request',
      timestamp: '2026-03-01T00:00:00Z',
    });
    const body = await getEvents(createEventsHandler(sql), `?${WINDOW}&limit=5000`);
    expect(body.events).toHaveLength(1);
  });
});
