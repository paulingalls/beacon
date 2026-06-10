import { beforeEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { Sql } from 'postgres';
import { withTestDb } from '../../test/helpers';
import { EventBuffer } from '../events/buffer';
import { ShortLinkCache } from './cache';
import { createRedirectHandler } from './redirect';
import { createShortLink, getShortLink } from './store';

const TEST_DB = process.env.TEST_DATABASE_URL;

// db-coverage guard (decision a02afa9ca404): a silent skip hides coverage gaps. Fail loud when
// the DB is expected but unset; the only sanctioned skip is the explicit BEACON_TEST_DB=off opt-out.
test('DB coverage: TEST_DATABASE_URL is set unless the DB is explicitly opted out', () => {
  expect(Boolean(TEST_DB) || process.env.BEACON_TEST_DB === 'off').toBe(true);
});
const SHORT_DOMAIN = 'https://pi.ink';

/** click_count is bumped fire-and-forget; poll until it reaches the target. */
async function pollClickCount(sql: Sql, code: string, target: number, tries = 25): Promise<number> {
  for (let i = 0; i < tries; i++) {
    const rows = await sql`SELECT click_count FROM beacon_short_links WHERE code = ${code}`;
    const count = (rows[0]?.click_count as number | undefined) ?? 0;
    if (count >= target) return count;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const rows = await sql`SELECT click_count FROM beacon_short_links WHERE code = ${code}`;
  return (rows[0]?.click_count as number | undefined) ?? 0;
}

async function clickEventCount(sql: Sql): Promise<number> {
  const rows =
    await sql`SELECT count(*)::int AS n FROM beacon_events WHERE event_type = 'short_link_click'`;
  return rows[0]?.n as number;
}

describe.skipIf(!TEST_DB)('redirect route (integration)', () => {
  const getSql = withTestDb(TEST_DB as string);

  // withTestDb truncates beacon_events/beacon_meta in its own hook; clean only
  // the short-links table here.
  beforeEach(async () => {
    await getSql()`TRUNCATE beacon_short_links`;
  });

  /** A redirect app over the shared sql, with a manually-flushed buffer. */
  function buildApp(sql: Sql) {
    const buffer = new EventBuffer(sql, { flushInterval: 60_000 }); // not started; flush manually
    const cache = new ShortLinkCache({ fetch: (code) => getShortLink(sql, code) });
    const app = new Hono();
    app.get('/:code', createRedirectHandler({ cache, sql, buffer }));
    return { app, buffer };
  }

  test('a valid code 302-redirects to the destination', async () => {
    const sql = getSql();
    const { app } = buildApp(sql);
    const link = await createShortLink(sql, {
      destination: 'https://clipcast.com/go',
      productId: 'clipcast',
      shortDomain: SHORT_DOMAIN,
    });

    const res = await app.request(`/${link.code}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://clipcast.com/go');
  });

  test('logs a short_link_click event with campaign attribution taking precedence over URL params', async () => {
    const sql = getSql();
    const { app, buffer } = buildApp(sql);
    const link = await createShortLink(sql, {
      destination: 'https://clipcast.com/go',
      productId: 'clipcast',
      campaign: { utm_source: 'twitter', launch: 'spring' },
      shortDomain: SHORT_DOMAIN,
    });

    const res = await app.request(`/${link.code}?utm_source=fromurl&utm_medium=email`);
    expect(res.status).toBe(302);

    await buffer.flush();
    const rows = await sql`
      SELECT product_id, properties, attribution
      FROM beacon_events WHERE event_type = 'short_link_click'`;
    expect(rows.length).toBe(1);
    const row = rows[0] as {
      product_id: string;
      properties: Record<string, unknown>;
      attribution: Record<string, unknown>;
    };
    expect(row.product_id).toBe('clipcast'); // from the link record, not a configured product
    expect(row.properties).toEqual({ code: link.code, destination: 'https://clipcast.com/go' });
    expect(row.attribution).toEqual({
      utm_source: 'twitter', // campaign wins the collision
      utm_medium: 'email', // URL param survives where campaign has no key
      launch: 'spring', // campaign-only key
    });
  });

  test('an unknown code returns 404 and logs no event', async () => {
    const sql = getSql();
    const { app, buffer } = buildApp(sql);

    const res = await app.request('/nope12');
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('not found');

    await buffer.flush();
    expect(await clickEventCount(sql)).toBe(0);
  });

  test('an expired code returns 404 and logs no event', async () => {
    const sql = getSql();
    const { app, buffer } = buildApp(sql);
    const link = await createShortLink(sql, {
      destination: 'https://clipcast.com/go',
      productId: 'clipcast',
      expiresAt: new Date(Date.now() - 1000),
      shortDomain: SHORT_DOMAIN,
    });

    const res = await app.request(`/${link.code}`);
    expect(res.status).toBe(404);

    await buffer.flush();
    expect(await clickEventCount(sql)).toBe(0);
  });

  test('a redirect increments the link click_count', async () => {
    const sql = getSql();
    const { app } = buildApp(sql);
    const link = await createShortLink(sql, {
      destination: 'https://clipcast.com/go',
      productId: 'clipcast',
      shortDomain: SHORT_DOMAIN,
    });

    await app.request(`/${link.code}`);
    expect(await pollClickCount(sql, link.code, 1)).toBe(1);
  });
});
