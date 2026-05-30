import { describe, expect, test } from 'bun:test';

import { RateLimiter } from './rateLimit';

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
