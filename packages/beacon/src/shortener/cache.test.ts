import { describe, expect, test } from 'bun:test';

import { ShortLinkCache } from './cache';
import type { ShortLinkRecord } from './store';

/** Build a minimal record; expires_at defaults to null (never expires). */
function rec(code: string, expiresAt: Date | null = null): ShortLinkRecord {
  return {
    code,
    destination: `https://example.com/${code}`,
    product_id: 'p',
    campaign: {},
    created_at: new Date(0),
    expires_at: expiresAt,
    click_count: 0,
  };
}

describe('ShortLinkCache', () => {
  test('a cache hit returns the record without calling fetch', async () => {
    let calls = 0;
    const cache = new ShortLinkCache({
      fetch: async (c) => {
        calls++;
        return rec(c);
      },
    });

    expect((await cache.get('AAAAAA'))?.code).toBe('AAAAAA'); // miss → fetch
    expect(calls).toBe(1);
    expect((await cache.get('AAAAAA'))?.code).toBe('AAAAAA'); // hit → no fetch
    expect(calls).toBe(1);
  });

  test('a miss falls through to fetch and populates the cache', async () => {
    let calls = 0;
    const cache = new ShortLinkCache({
      fetch: async (c) => {
        calls++;
        return rec(c);
      },
    });

    await cache.get('BBBBBB');
    await cache.get('BBBBBB');
    expect(calls).toBe(1); // second get served from cache
  });

  test('re-fetches once the cache TTL has elapsed', async () => {
    let now = 1000;
    let calls = 0;
    const cache = new ShortLinkCache({
      ttl: 500,
      now: () => now,
      fetch: async (c) => {
        calls++;
        return rec(c);
      },
    });

    await cache.get('CCCCCC'); // cached at 1000
    now = 1400; // 400 <= 500 → still fresh
    await cache.get('CCCCCC');
    expect(calls).toBe(1);
    now = 1600; // 600 > 500 → expired
    await cache.get('CCCCCC');
    expect(calls).toBe(2);
  });

  test('re-fetches a link that expired while cached (expiry filter not bypassed)', async () => {
    let now = 1000;
    let calls = 0;
    const expiresAt = new Date(2000); // link valid until epoch-ms 2000
    const cache = new ShortLinkCache({
      ttl: 10_000, // long cache TTL, so only link-expiry can force a re-fetch
      now: () => now,
      fetch: async (c) => {
        calls++;
        return rec(c, expiresAt);
      },
    });

    await cache.get('DDDDDD'); // cached at 1000, link live (2000 > 1000)
    now = 1500; // still live
    await cache.get('DDDDDD');
    expect(calls).toBe(1);
    now = 2500; // link expired (2000 <= 2500) though cache TTL has not elapsed
    await cache.get('DDDDDD');
    expect(calls).toBe(2); // re-fetched rather than served stale
  });

  test('evicts the least-recently-used entry at capacity', async () => {
    let fetched: string[] = [];
    const cache = new ShortLinkCache({
      size: 2,
      fetch: async (c) => {
        fetched.push(c);
        return rec(c);
      },
    });

    await cache.get('AAAAAA'); // [A]
    await cache.get('BBBBBB'); // [A, B]
    await cache.get('AAAAAA'); // hit, A → most-recent: [B, A]
    await cache.get('CCCCCC'); // at capacity → evict LRU (B): [A, C]

    fetched = [];
    await cache.get('AAAAAA'); // still cached → no fetch
    expect(fetched).toEqual([]);
    await cache.get('BBBBBB'); // evicted → re-fetch
    expect(fetched).toEqual(['BBBBBB']);
  });

  test('invalidate removes an entry so the next get re-fetches', async () => {
    let calls = 0;
    const cache = new ShortLinkCache({
      fetch: async (c) => {
        calls++;
        return rec(c);
      },
    });

    await cache.get('EEEEEE');
    cache.invalidate('EEEEEE');
    await cache.get('EEEEEE');
    expect(calls).toBe(2);
  });

  test('throws on a misconfigured size or ttl', () => {
    const fetch = async (c: string) => rec(c);
    expect(() => new ShortLinkCache({ fetch, size: 0 })).toThrow(RangeError);
    expect(() => new ShortLinkCache({ fetch, size: -1 })).toThrow(RangeError);
    expect(() => new ShortLinkCache({ fetch, ttl: 0 })).toThrow(RangeError);
    expect(() => new ShortLinkCache({ fetch, ttl: -1 })).toThrow(RangeError);
  });

  test('does not cache a null fetch result (unknown/expired code)', async () => {
    let calls = 0;
    const cache = new ShortLinkCache({
      fetch: async () => {
        calls++;
        return null;
      },
    });

    expect(await cache.get('ZZZZZZ')).toBeNull();
    expect(await cache.get('ZZZZZZ')).toBeNull();
    expect(calls).toBe(2); // a negative result is re-fetched, never cached
  });
});
