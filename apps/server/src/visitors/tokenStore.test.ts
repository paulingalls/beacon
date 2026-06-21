import { afterEach, describe, expect, test } from 'bun:test';

import type { Attribution } from '@pi-innovations/beacon-sdk';
import { VisitorTokenStore } from './tokenStore';

/** A mutable fake clock so TTL/sliding-window tests need no real waits. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    set: (ms: number) => {
      t = ms;
    },
  };
}

// Track stores so their sweep intervals are always cleared, even on assertion failure.
const open: VisitorTokenStore[] = [];
function makeStore(opts: Partial<{ ttl: number; maxEntries: number; now: () => number }> = {}) {
  const store = new VisitorTokenStore(opts);
  open.push(store);
  return store;
}
afterEach(() => {
  while (open.length) open.pop()?.stop();
});

describe('VisitorTokenStore — generation', () => {
  test('create() returns a 12-char URL-safe token', () => {
    const token = makeStore().create('ip-hash', 'ua');
    expect(token).toHaveLength(12);
    expect(token).toMatch(/^[A-Za-z0-9_-]{12}$/);
  });

  test('create() yields distinct tokens', () => {
    const store = makeStore();
    const a = store.create('h', 'ua');
    const b = store.create('h', 'ua');
    expect(a).not.toBe(b);
  });

  test('create() stores a record with the clock time, null attribution, ipHash, userAgent', () => {
    const clock = fakeClock();
    const store = makeStore({ now: clock.now });
    const token = store.create('hashed-ip', 'Mozilla/5.0');
    expect(store.get(token)).toEqual({
      token,
      createdAt: clock.now(),
      lastSeenAt: clock.now(),
      attribution: null,
      ipHash: 'hashed-ip',
      userAgent: 'Mozilla/5.0',
    });
  });
});

describe('VisitorTokenStore — lookup & touch', () => {
  test('get() returns the record for a known token, null for unknown', () => {
    const store = makeStore();
    const token = store.create('h', 'ua');
    expect(store.get(token)?.token).toBe(token);
    expect(store.get('nope')).toBeNull();
  });

  test('touch() advances lastSeenAt only, leaving createdAt unchanged', () => {
    const clock = fakeClock();
    const store = makeStore({ now: clock.now });
    const token = store.create('h', 'ua');
    const createdAt = store.get(token)?.createdAt;
    clock.advance(5_000);
    store.touch(token);
    expect(store.get(token)?.lastSeenAt).toBe(clock.now());
    expect(store.get(token)?.createdAt).toBe(createdAt);
  });

  test('touch() on an unknown token is a safe no-op', () => {
    expect(() => makeStore().touch('nope')).not.toThrow();
  });
});

describe('VisitorTokenStore — TTL sweep', () => {
  test('sweep() removes entries older than ttl measured from lastSeenAt', () => {
    const clock = fakeClock();
    const store = makeStore({ ttl: 30_000, now: clock.now });
    const token = store.create('h', 'ua');
    clock.advance(30_001);
    store.sweep();
    expect(store.get(token)).toBeNull();
    expect(store.stats().active).toBe(0);
  });

  test('sweep() keeps entries within ttl', () => {
    const clock = fakeClock();
    const store = makeStore({ ttl: 30_000, now: clock.now });
    const token = store.create('h', 'ua');
    clock.advance(29_999);
    store.sweep();
    expect(store.get(token)?.token).toBe(token);
  });

  test('sliding window: touch() before expiry resets the TTL clock', () => {
    const clock = fakeClock();
    const store = makeStore({ ttl: 30_000, now: clock.now });
    const token = store.create('h', 'ua');
    clock.advance(29_000);
    store.touch(token); // resets lastSeenAt
    clock.advance(29_000); // 58s since create, but only 29s since touch
    store.sweep();
    expect(store.get(token)?.token).toBe(token);
  });
});

describe('VisitorTokenStore — capacity eviction', () => {
  test('at maxEntries, create() evicts the oldest-by-lastSeenAt first', () => {
    const clock = fakeClock();
    const store = makeStore({ maxEntries: 2, now: clock.now });
    const a = store.create('h', 'ua');
    clock.advance(1_000);
    const b = store.create('h', 'ua');
    clock.advance(1_000);
    store.touch(a); // a is now newer than b
    clock.advance(1_000);
    const c = store.create('h', 'ua'); // capacity hit -> evict oldest (b)

    expect(store.get(b)).toBeNull();
    expect(store.get(a)?.token).toBe(a);
    expect(store.get(c)?.token).toBe(c);
    expect(store.stats().active).toBe(2);
  });

  test('eviction follows touch-recency across a sequence (front-of-Map order, O(1))', () => {
    // Characterizes the ordering invariant the O(1) eviction relies on: the Map is
    // kept ordered by lastSeenAt, so the least-recently-touched record is always the
    // victim — proven by the victims tracking touch-recency, not insertion order.
    // (A wall-clock "no O(n) scan" assertion would be flaky; this is the honest proxy.)
    const clock = fakeClock();
    const store = makeStore({ maxEntries: 3, now: clock.now });
    const a = store.create('h', 'ua');
    clock.advance(1_000);
    const b = store.create('h', 'ua');
    clock.advance(1_000);
    const c = store.create('h', 'ua');

    clock.advance(1_000);
    store.touch(a); // a becomes newest; oldest is now b
    clock.advance(1_000);
    const d = store.create('h', 'ua'); // at capacity -> evicts b (the oldest)
    expect(store.get(b)).toBeNull();
    expect(store.get(a)?.token).toBe(a); // a survived: it was touched out of the front

    clock.advance(1_000);
    store.touch(c); // c becomes newest; now a is the oldest (its touch predates d/c)
    clock.advance(1_000);
    const e = store.create('h', 'ua'); // at capacity -> evicts a
    expect(store.get(a)).toBeNull(); // recency moved on; a is now the least-recently-seen
    expect(store.get(c)?.token).toBe(c);
    expect(store.get(d)?.token).toBe(d);
    expect(store.get(e)?.token).toBe(e);
    expect(store.stats().evicted).toBe(2);
    expect(store.stats().active).toBe(3);
  });

  test('stats().evicted counts capacity evictions, not TTL-sweep removals', () => {
    const clock = fakeClock();
    const store = makeStore({ ttl: 10_000, maxEntries: 1, now: clock.now });
    store.create('h', 'ua');
    store.create('h', 'ua'); // evicts the first -> evicted = 1
    expect(store.stats().evicted).toBe(1);

    clock.advance(10_001);
    store.sweep(); // expiry, not eviction
    expect(store.stats().evicted).toBe(1);
    expect(store.stats().active).toBe(0);
  });
});

describe('VisitorTokenStore — first-touch attribution', () => {
  const attr: Attribution = { utm_source: 'newsletter' };

  test('setAttribution() stores attribution on first call', () => {
    const store = makeStore();
    const token = store.create('h', 'ua');
    store.setAttribution(token, attr);
    expect(store.get(token)?.attribution).toEqual(attr);
  });

  test('setAttribution() is a no-op when attribution is already set (first-touch)', () => {
    const store = makeStore();
    const token = store.create('h', 'ua');
    store.setAttribution(token, attr);
    store.setAttribution(token, { utm_source: 'paid' });
    expect(store.get(token)?.attribution).toEqual(attr);
  });

  test('setAttribution() on an unknown token is a safe no-op', () => {
    expect(() => makeStore().setAttribution('nope', attr)).not.toThrow();
  });
});

describe('VisitorTokenStore — lifecycle', () => {
  test('remove() deletes the record', () => {
    const store = makeStore();
    const token = store.create('h', 'ua');
    store.remove(token);
    expect(store.get(token)).toBeNull();
    expect(store.stats().active).toBe(0);
  });

  test('stop() is safe and idempotent', () => {
    const store = new VisitorTokenStore();
    expect(() => {
      store.stop();
      store.stop();
    }).not.toThrow();
  });
});
