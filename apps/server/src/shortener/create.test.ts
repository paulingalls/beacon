import { beforeEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { Sql } from 'postgres';
import { registerDbCoverageGuard, TEST_DB } from '../../../../packages/beacon/test/dbGuard';
import { withTestDb } from '../../../../packages/beacon/test/helpers';
import { adminGate } from '../api/auth';
import { createCreateHandler } from './create';

const SHORT_DOMAIN = 'https://pi.ink';

interface BuildOpts {
  isAdmin?: (c: unknown) => boolean;
  rateLimit?: { limit?: number; windowMs?: number };
}

registerDbCoverageGuard();

describe.skipIf(!TEST_DB)('create route POST /short (integration)', () => {
  const getSql = withTestDb(TEST_DB as string);

  beforeEach(async () => {
    await getSql()`TRUNCATE beacon_short_links`;
  });

  function buildApp(sql: Sql, opts: BuildOpts = {}) {
    const isAdmin = opts.isAdmin ?? (() => true);
    const app = new Hono();
    app.post(
      '/short',
      // biome-ignore lint/suspicious/noExplicitAny: test composes the real gate
      adminGate({ isAdmin: isAdmin as (c: any) => boolean }),
      createCreateHandler({ sql, shortDomain: SHORT_DOMAIN, rateLimit: opts.rateLimit }),
    );
    return app;
  }

  function post(app: Hono, body: unknown) {
    return app.request('/short', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  test('an admin with a valid body gets 201 and the link object', async () => {
    const sql = getSql();
    const expiresAt = '2027-01-01T00:00:00.000Z';
    const res = await post(buildApp(sql), {
      destination: 'https://clipcast.com/signup',
      product_id: 'clipcast',
      campaign: { source: 'twitter' },
      expires_at: expiresAt,
    });

    expect(res.status).toBe(201);
    const link = (await res.json()) as {
      code: string;
      destination: string;
      url: string;
      created_at: string;
      expires_at: string;
    };
    expect(link.code).toMatch(/^[a-zA-Z0-9]{6}$/);
    expect(link.destination).toBe('https://clipcast.com/signup');
    expect(link.url).toBe(`${SHORT_DOMAIN}/${link.code}`);
    expect(link.created_at).toBeDefined();
    expect(new Date(link.expires_at).toISOString()).toBe(expiresAt);

    const rows =
      await sql`SELECT product_id, campaign FROM beacon_short_links WHERE code = ${link.code}`;
    expect(rows[0]?.product_id).toBe('clipcast');
    expect(rows[0]?.campaign).toEqual({ source: 'twitter' });
  });

  test('a missing destination returns 400 MISSING_PARAMETER', async () => {
    const res = await post(buildApp(getSql()), { product_id: 'clipcast' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'MISSING_PARAMETER',
    );
  });

  test('an empty-string destination returns 400 MISSING_PARAMETER and creates no row', async () => {
    const sql = getSql();
    const res = await post(buildApp(sql), { destination: '', product_id: 'clipcast' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'MISSING_PARAMETER',
    );
    const rows = await sql`SELECT code FROM beacon_short_links`;
    expect(rows).toHaveLength(0);
  });

  test('a whitespace-only destination returns 400 MISSING_PARAMETER (parity with the store guard)', async () => {
    const res = await post(buildApp(getSql()), { destination: '   ', product_id: 'clipcast' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'MISSING_PARAMETER',
    );
  });

  test('a missing product_id returns 400 MISSING_PARAMETER', async () => {
    const res = await post(buildApp(getSql()), { destination: 'https://x.com' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'MISSING_PARAMETER',
    );
  });

  test('a non-object JSON body (array) returns 400 INVALID_PARAMETER body', async () => {
    const res = await post(buildApp(getSql()), ['not', 'an', 'object']);
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: { code: string; parameter?: string } };
    expect(error.code).toBe('INVALID_PARAMETER');
    expect(error.parameter).toBe('body');
  });

  test('a non-URL destination returns 400 INVALID_PARAMETER', async () => {
    const res = await post(buildApp(getSql()), { destination: 'not a url', product_id: 'p' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'INVALID_PARAMETER',
    );
  });

  test('a non-http(s) scheme destination returns 400 INVALID_PARAMETER', async () => {
    const res = await post(buildApp(getSql()), {
      destination: 'javascript:alert(1)',
      product_id: 'p',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'INVALID_PARAMETER',
    );
  });

  test('exceeding the creation rate limit returns 429 RATE_LIMITED with Retry-After', async () => {
    const app = buildApp(getSql(), { rateLimit: { limit: 1 } });
    const ok = await post(app, { destination: 'https://x.com', product_id: 'p' });
    expect(ok.status).toBe(201);

    const limited = await post(app, { destination: 'https://x.com', product_id: 'p' });
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { error: { code: string } }).error.code).toBe('RATE_LIMITED');
    expect(limited.headers.get('retry-after')).toBeTruthy();
  });

  test('a non-admin caller returns 403 UNAUTHORIZED', async () => {
    const app = buildApp(getSql(), { isAdmin: () => false });
    const res = await post(app, { destination: 'https://x.com', product_id: 'p' });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('UNAUTHORIZED');
  });
});
