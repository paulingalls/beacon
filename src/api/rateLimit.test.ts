import { describe, expect, test } from 'bun:test';

import { type Context, Hono } from 'hono';

import { RateLimiter, rateLimitGate } from './rateLimit';

/** A controllable clock: now() reads the current time, advance(ms) moves it forward. */
function clock(start = 1000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('RateLimiter', () => {
  test('allows up to the limit, then denies further requests in the window', () => {
    const rl = new RateLimiter({ limit: 10, windowMs: 60_000, now: clock().now });
    for (let i = 0; i < 10; i++) {
      expect(rl.check('ip').allowed).toBe(true);
    }
    expect(rl.check('ip').allowed).toBe(false); // 11th within the window
  });

  test('an allowed request reports retryAfter 0', () => {
    const rl = new RateLimiter({ limit: 5, windowMs: 60_000, now: clock().now });
    expect(rl.check('ip')).toEqual({ allowed: true, retryAfter: 0 });
  });

  test('allows again once the window has fully elapsed', () => {
    const c = clock();
    const rl = new RateLimiter({ limit: 2, windowMs: 60_000, now: c.now });
    rl.check('ip');
    rl.check('ip');
    expect(rl.check('ip').allowed).toBe(false);

    c.advance(60_000); // the two hits (t=1000) now sit exactly at the window edge → expired
    expect(rl.check('ip').allowed).toBe(true);
  });

  test('stays limited while only part of the window has elapsed', () => {
    const c = clock();
    const rl = new RateLimiter({ limit: 1, windowMs: 60_000, now: c.now });
    rl.check('ip');
    c.advance(30_000);
    expect(rl.check('ip').allowed).toBe(false);
  });

  test('retryAfter is a positive whole-second value that shrinks as the window rolls', () => {
    const c = clock();
    const rl = new RateLimiter({ limit: 1, windowMs: 60_000, now: c.now });
    rl.check('ip'); // hit at t=1000, expires at t=61000

    const first = rl.check('ip');
    expect(first.allowed).toBe(false);
    expect(first.retryAfter).toBe(60); // 60000ms until expiry

    c.advance(10_000);
    expect(rl.check('ip').retryAfter).toBe(50); // 50000ms left
  });

  test('rounds a partial second up so retryAfter is never below 1', () => {
    const c = clock();
    const rl = new RateLimiter({ limit: 1, windowMs: 1_000, now: c.now });
    rl.check('ip'); // hit at t=1000, expires at t=2000
    c.advance(700); // now t=1700, 300ms until expiry
    expect(rl.check('ip').retryAfter).toBe(1); // ceil(0.3s) = 1
  });

  test('isolates limits per identifier', () => {
    const rl = new RateLimiter({ limit: 1, windowMs: 60_000, now: clock().now });
    rl.check('a');
    expect(rl.check('a').allowed).toBe(false);
    expect(rl.check('b').allowed).toBe(true); // a hitting its limit does not affect b
  });

  test('does not record denied requests (a denial cannot push the reset further out)', () => {
    const c = clock();
    const rl = new RateLimiter({ limit: 1, windowMs: 60_000, now: c.now });
    rl.check('ip'); // recorded hit at t=1000

    c.advance(30_000);
    expect(rl.check('ip').allowed).toBe(false); // denied at t=31000 — must NOT be recorded

    c.advance(30_000); // now t=61000: the original hit (t=1000) has expired
    // If the denied call at t=31000 had been recorded, it would still be in-window
    // (61000-31000 < 60000) and this would be denied. Allowed proves denials aren't kept.
    expect(rl.check('ip').allowed).toBe(true);
  });

  test('defaults to the real clock when no now() is injected', () => {
    const rl = new RateLimiter({ limit: 1, windowMs: 1_000 });
    expect(rl.check('ip').allowed).toBe(true);
  });

  test('rejects a non-positive limit at construction (fail fast)', () => {
    expect(() => new RateLimiter({ limit: 0, windowMs: 60_000 })).toThrow(RangeError);
    expect(() => new RateLimiter({ limit: -1, windowMs: 60_000 })).toThrow(RangeError);
  });

  test('rejects a non-positive window at construction (fail fast)', () => {
    expect(() => new RateLimiter({ limit: 10, windowMs: 0 })).toThrow(RangeError);
    expect(() => new RateLimiter({ limit: 10, windowMs: -1 })).toThrow(RangeError);
  });
});

/** Mount rateLimitGate ahead of a trailing 200 handler. `?u=` drives getUserId;
 * the `x-forwarded-for` header drives the IP fallback (hashIPs off for readable keys). */
function appWith(
  limiter: RateLimiter,
  getUserId: (c: Context) => string | null = (c) => c.req.query('u') ?? null,
): Hono {
  const app = new Hono();
  app.use('/q', rateLimitGate({ limiter, getUserId, hashIPs: false }));
  app.get('/q', (c) => c.text('ok'));
  return app;
}

/** Request /q with an optional client IP (x-forwarded-for) and user query param. */
async function get(app: Hono, opts: { ip?: string; u?: string } = {}): Promise<Response> {
  const path = opts.u ? `/q?u=${opts.u}` : '/q';
  const headers = opts.ip ? { 'x-forwarded-for': opts.ip } : undefined;
  return app.request(path, headers ? { headers } : undefined);
}

describe('rateLimitGate', () => {
  test('allows a request under the limit (200)', async () => {
    const app = appWith(new RateLimiter({ limit: 2, windowMs: 60_000, now: clock().now }));
    const res = await app.request('/q?u=alice');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  test('rejects over the limit with a §5.5 RATE_LIMITED 429 + Retry-After', async () => {
    const app = appWith(new RateLimiter({ limit: 1, windowMs: 60_000, now: clock().now }));
    expect((await app.request('/q?u=alice')).status).toBe(200);
    const res = await app.request('/q?u=alice'); // 2nd in the window
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('RATE_LIMITED');
  });

  test('isolates limits per user id', async () => {
    const app = appWith(new RateLimiter({ limit: 1, windowMs: 60_000, now: clock().now }));
    expect((await app.request('/q?u=alice')).status).toBe(200);
    expect((await app.request('/q?u=alice')).status).toBe(429); // alice exhausted
    expect((await app.request('/q?u=bob')).status).toBe(200); // bob unaffected
  });

  test('a null user id falls back to the client IP — same IP shares one bucket', async () => {
    const app = appWith(new RateLimiter({ limit: 1, windowMs: 60_000, now: clock().now }));
    expect((await get(app, { ip: '1.1.1.1' })).status).toBe(200); // no ?u → keyed by IP
    expect((await get(app, { ip: '1.1.1.1' })).status).toBe(429); // same IP shares the bucket
  });

  test('null user ids from different client IPs get separate buckets (no shared-anonymous bypass)', async () => {
    const app = appWith(new RateLimiter({ limit: 1, windowMs: 60_000, now: clock().now }));
    expect((await get(app, { ip: '1.1.1.1' })).status).toBe(200);
    expect((await get(app, { ip: '2.2.2.2' })).status).toBe(200); // different IP → own bucket
    expect((await get(app, { ip: '1.1.1.1' })).status).toBe(429); // 1.1.1.1 already spent
  });

  test('with no user id and no resolvable IP, callers share the anonymous bucket', async () => {
    const app = appWith(new RateLimiter({ limit: 1, windowMs: 60_000, now: clock().now }));
    expect((await app.request('/q')).status).toBe(200); // no ?u, no x-forwarded-for
    expect((await app.request('/q')).status).toBe(429); // both fall back to ANONYMOUS_KEY
  });

  test('a throwing getUserId is failure-isolated to the IP fallback (not a 500)', async () => {
    const app = appWith(new RateLimiter({ limit: 1, windowMs: 60_000, now: clock().now }), () => {
      throw new Error('getUserId boom');
    });
    expect((await get(app, { ip: '9.9.9.9' })).status).toBe(200); // first allowed, no crash
    expect((await get(app, { ip: '9.9.9.9' })).status).toBe(429); // same IP shares the bucket
  });

  test('does not call the downstream handler when rejecting', async () => {
    let reached = false;
    const app = new Hono();
    app.use(
      '/q',
      rateLimitGate({
        limiter: new RateLimiter({ limit: 1, windowMs: 60_000, now: clock().now }),
        getUserId: () => 'a',
      }),
    );
    app.get('/q', (c) => {
      reached = true;
      return c.text('ok');
    });
    await app.request('/q'); // consume the one allowed slot
    reached = false;
    await app.request('/q'); // denied
    expect(reached).toBe(false);
  });
});
