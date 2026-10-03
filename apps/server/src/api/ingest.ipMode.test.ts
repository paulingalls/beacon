import { expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import type { Sql } from 'postgres';
import { createCreateHandler } from '../shortener/create';
import { createIpPolicy } from '../visitors/ipSalt';
import { createIngestHandler } from './ingest';
import { RateLimiter, rateLimitGate } from './rateLimit';

for (const hashIPs of [undefined, true, false]) {
  for (const userId of [null, 'user-123']) {
    test(`ipMode default compatibility limiter keys ${hashIPs}/${userId}`, async () => {
      const policy = createIpPolicy({ hashIPs });
      const check = spyOn(RateLimiter.prototype, 'check');
      const app = new Hono();
      app.post(
        '/events',
        createIngestHandler(
          { push: () => {} },
          { productId: 'test', ipPolicy: policy, getUserId: () => userId },
        ),
      );
      app.get(
        '/query',
        rateLimitGate({
          limiter: new RateLimiter({ limit: 2, windowMs: 60000 }),
          ipPolicy: policy,
          hashIPs,
          getUserId: () => userId,
        }),
        (c) => c.text('ok'),
      );
      app.post(
        '/short',
        createCreateHandler({
          sql: (() => {
            throw new Error('unexpected DB');
          }) as unknown as Sql,
          shortDomain: '',
          ipPolicy: policy,
          hashIPs,
          getUserId: () => userId,
        }),
      );
      try {
        const ip = '198.51.100.9';
        const headers = { 'x-forwarded-for': ip, 'content-type': 'application/json' };
        expect(
          (await app.request('/events', { method: 'POST', headers, body: '{"events":[]}' })).status,
        ).toBe(202);
        expect((await app.request('/query', { headers })).status).toBe(200);
        expect((await app.request('/short', { method: 'POST', headers, body: '{}' })).status).toBe(
          400,
        );
        const expected =
          userId ?? (hashIPs === false ? ip : createHash('sha256').update(ip).digest('hex'));
        const queryExpected =
          userId ?? (hashIPs === true ? createHash('sha256').update(ip).digest('hex') : ip);
        expect(check.mock.calls.map(([key]) => key)).toEqual([expected, queryExpected, expected]);
      } finally {
        check.mockRestore();
        policy.stop();
      }
    });
  }
}
test('ipMode query standalone default remains raw ephemeral key', async () => {
  const check = spyOn(RateLimiter.prototype, 'check');
  const app = new Hono();
  app.get(
    '/',
    rateLimitGate({
      limiter: new RateLimiter({ limit: 1, windowMs: 60000 }),
      getUserId: () => null,
    }),
    (c) => c.text('ok'),
  );
  try {
    await app.request('/', { headers: { 'x-forwarded-for': '198.51.100.9' } });
    expect(check.mock.calls[0]?.[0]).toBe('198.51.100.9');
  } finally {
    check.mockRestore();
  }
});

for (const ipMode of ['daily-salt', 'none'] as const) {
  for (const boundary of ['ingest', 'query', 'shortener'] as const) {
    test(`ipMode ${ipMode} ${boundary} keeps live quota across midnight and isolates clients`, async () => {
      let time = Date.parse('2026-10-02T23:59:59.999Z');
      let salt = 0;
      const now = () => time;
      const policy = createIpPolicy(
        { ipMode },
        {
          now,
          salt: () => Buffer.alloc(32, ++salt),
          schedule: () => () => {},
        },
      );
      const rateLimit = { limit: 1, windowMs: 3600000, now };
      const app = new Hono();
      app.post(
        '/events',
        createIngestHandler(
          { push: () => {} },
          {
            productId: 'test',
            ipPolicy: policy,
            rateLimit,
          },
        ),
      );
      app.get(
        '/query',
        rateLimitGate({
          limiter: new RateLimiter(rateLimit),
          ipPolicy: policy,
          getUserId: () => null,
        }),
        (c) => c.text('ok'),
      );
      app.post(
        '/short',
        createCreateHandler({
          sql: (() => {
            throw new Error('unexpected DB');
          }) as unknown as Sql,
          shortDomain: '',
          ipPolicy: policy,
          rateLimit,
        }),
      );
      const server = Bun.serve({ port: 0, fetch: app.fetch });
      const path = boundary === 'ingest' ? '/events' : boundary === 'query' ? '/query' : '/short';
      const allowed = boundary === 'ingest' ? 202 : boundary === 'query' ? 200 : 400;
      const request = (ip = '198.51.100.9') =>
        fetch(`http://localhost:${server.port}${path}`, {
          method: boundary === 'query' ? 'GET' : 'POST',
          headers: { 'x-forwarded-for': ip, 'content-type': 'application/json' },
          ...(boundary === 'query' ? {} : { body: boundary === 'ingest' ? '{"events":[]}' : '{}' }),
        });
      try {
        const before = policy.storage('198.51.100.9');
        expect((await request()).status).toBe(allowed);
        const denied = await request();
        expect(denied.status).toBe(429);
        expect(denied.headers.get('retry-after')).toBe('3600');
        time += 1;
        if (ipMode === 'daily-salt') expect(policy.storage('198.51.100.9')).not.toBe(before);
        const rollover = await request();
        expect(rollover.status).toBe(429);
        expect(rollover.headers.get('retry-after')).toBe('3600');
        expect((await request('203.0.113.7')).status).toBe(allowed);
        expect((await request()).status).toBe(429);
        time += 3599999;
        expect((await request()).status).toBe(allowed);
      } finally {
        server.stop(true);
        policy.stop();
      }
    });
  }
}
