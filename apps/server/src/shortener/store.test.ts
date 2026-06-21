import { beforeEach, describe, expect, test } from 'bun:test';
import type { Sql } from 'postgres';
import { registerDbCoverageGuard, TEST_DB } from '../../test/dbGuard';

import { withTestDb } from '../../test/helpers';
import { createShortLink, getShortLink, incrementClickCount } from './store';

const SHORT_DOMAIN = 'https://pi.ink';

registerDbCoverageGuard();

// createShortLink validates its inputs BEFORE any query, so both the admin HTTP
// path (POST /short) and the programmatic beacon.createShortLink() reject the
// same bad inputs — no DB needed. `unusedSql` proves the rejection happens
// before the insert: a tagged-template call on it throws a distinct error.
describe('createShortLink input validation (no DB — rejects before insert)', () => {
  const unusedSql = (() => {
    throw new Error('sql must not be called when validation rejects');
  }) as unknown as Sql;

  test('rejects a non-http(s) destination (e.g. javascript:) so it can never 302 to it', async () => {
    await expect(
      createShortLink(unusedSql, {
        destination: 'javascript:alert(1)',
        productId: 'p',
        shortDomain: SHORT_DOMAIN,
      }),
    ).rejects.toThrow(/http/i);
  });

  test('rejects an empty or whitespace destination with a "destination is required" message', async () => {
    for (const destination of ['', '   ']) {
      await expect(
        createShortLink(unusedSql, { destination, productId: 'p', shortDomain: SHORT_DOMAIN }),
      ).rejects.toThrow(/destination is required/i);
    }
  });

  test('rejects a non-empty, non-URL destination as not a valid http(s) URL', async () => {
    await expect(
      createShortLink(unusedSql, {
        destination: 'not a url',
        productId: 'p',
        shortDomain: SHORT_DOMAIN,
      }),
    ).rejects.toThrow(/http/i);
  });

  test('rejects an empty product_id', async () => {
    await expect(
      createShortLink(unusedSql, {
        destination: 'https://example.com',
        productId: '',
        shortDomain: SHORT_DOMAIN,
      }),
    ).rejects.toThrow(/product/i);
  });
});

describe.skipIf(!TEST_DB)('short-link store (integration)', () => {
  const getSql = withTestDb(TEST_DB as string);

  // withTestDb's beforeEach truncates beacon_events/beacon_meta only — short
  // links persist across its hooks, so clean the table here for isolation.
  beforeEach(async () => {
    await getSql()`TRUNCATE beacon_short_links`;
  });

  test('createShortLink inserts a row and returns a link whose url uses shortDomain', async () => {
    const sql = getSql();
    const link = await createShortLink(sql, {
      destination: 'https://clipcast.com/signup',
      productId: 'clipcast',
      shortDomain: SHORT_DOMAIN,
    });

    expect(link.code).toMatch(/^[a-zA-Z0-9]{6}$/);
    expect(link.destination).toBe('https://clipcast.com/signup');
    expect(link.url).toBe(`${SHORT_DOMAIN}/${link.code}`);
    expect(link.created_at).toBeInstanceOf(Date);
    expect(link.expires_at).toBeNull();

    const fetched = await getShortLink(sql, link.code);
    expect(fetched?.destination).toBe('https://clipcast.com/signup');
    expect(fetched?.product_id).toBe('clipcast');
    expect(fetched?.click_count).toBe(0);
  });

  test('createShortLink strips a trailing slash from shortDomain (no double slash)', async () => {
    const sql = getSql();
    const link = await createShortLink(sql, {
      destination: 'https://clipcast.com/signup',
      productId: 'clipcast',
      shortDomain: 'https://pi.ink/',
    });

    expect(link.url).toBe(`https://pi.ink/${link.code}`);
  });

  test('createShortLink persists campaign JSONB and expires_at', async () => {
    const sql = getSql();
    const expiresAt = new Date(Date.now() + 86_400_000);
    const link = await createShortLink(sql, {
      destination: 'https://x.com',
      productId: 'p',
      campaign: { source: 'twitter', medium: 'social' },
      expiresAt,
      shortDomain: SHORT_DOMAIN,
    });

    const fetched = await getShortLink(sql, link.code);
    expect(fetched?.campaign).toEqual({ source: 'twitter', medium: 'social' });
    expect(fetched?.expires_at).toEqual(expiresAt);
  });

  test('getShortLink returns null for an expired link', async () => {
    const sql = getSql();
    const link = await createShortLink(sql, {
      destination: 'https://x.com',
      productId: 'p',
      expiresAt: new Date(Date.now() - 1000),
      shortDomain: SHORT_DOMAIN,
    });

    expect(await getShortLink(sql, link.code)).toBeNull();
  });

  test('getShortLink returns null for an unknown code', async () => {
    expect(await getShortLink(getSql(), 'nope12')).toBeNull();
  });

  test('createShortLink retries on collision and succeeds with a fresh code', async () => {
    const sql = getSql();
    // Occupy 'AAAAAA' so the next create collides on its first attempt.
    await createShortLink(
      sql,
      { destination: 'https://a.com', productId: 'p', shortDomain: SHORT_DOMAIN },
      () => 'AAAAAA',
    );

    let calls = 0;
    const gen = () => (++calls === 1 ? 'AAAAAA' : 'BBBBBB');
    const link = await createShortLink(
      sql,
      { destination: 'https://b.com', productId: 'p', shortDomain: SHORT_DOMAIN },
      gen,
    );

    expect(link.code).toBe('BBBBBB');
    expect(calls).toBe(2); // first attempt collided, second won
  });

  test('createShortLink throws after 3 consecutive collisions', async () => {
    const sql = getSql();
    await createShortLink(
      sql,
      { destination: 'https://a.com', productId: 'p', shortDomain: SHORT_DOMAIN },
      () => 'DUPED1',
    );

    await expect(
      createShortLink(
        sql,
        { destination: 'https://b.com', productId: 'p', shortDomain: SHORT_DOMAIN },
        () => 'DUPED1',
      ),
    ).rejects.toThrow();
  });

  test('incrementClickCount raises click_count by 1', async () => {
    const sql = getSql();
    const link = await createShortLink(sql, {
      destination: 'https://x.com',
      productId: 'p',
      shortDomain: SHORT_DOMAIN,
    });

    await incrementClickCount(sql, link.code);

    const rows = await sql`SELECT click_count FROM beacon_short_links WHERE code = ${link.code}`;
    expect(rows[0]?.click_count).toBe(1);
  });
});
