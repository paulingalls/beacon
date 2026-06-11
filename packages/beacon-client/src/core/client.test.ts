import { describe, expect, test } from 'bun:test';

import {
  APP_CONTEXT,
  APP_CONTEXT_HEADER,
  allEvents,
  build,
  makeClock,
  makeFetch,
  makeStorage,
  type RecordedCall,
  tick,
} from '../testkit';
import { BeaconClient } from './client';
import type { BeaconEvent, BeaconStorageAdapter } from './types';

describe('BeaconClient construction', () => {
  test('throws RangeError on invalid config', () => {
    const base = { productId: 'p', appContext: APP_CONTEXT };
    expect(() => new BeaconClient({ ...base, endpoint: '' })).toThrow(RangeError);
    expect(
      () => new BeaconClient({ endpoint: 'x', productId: '', appContext: APP_CONTEXT }),
    ).toThrow(RangeError);
    expect(() => new BeaconClient({ ...base, endpoint: 'x', maxBatchSize: 101 })).toThrow(
      RangeError,
    );
    expect(() => new BeaconClient({ ...base, endpoint: 'x', flushInterval: 0 })).toThrow(
      RangeError,
    );
  });
});

describe('track / screenView', () => {
  test('track queues an event with the right shape and an ISO-8601 timestamp', async () => {
    const { client, calls } = build();
    client.track('button_tap', { button: 'create_clip' });
    await client.flush();

    expect(calls).toHaveLength(1);
    const [event] = calls[0]?.body.events ?? [];
    expect(event?.event_type).toBe('button_tap');
    expect(event?.properties).toEqual({ button: 'create_clip' });
    expect(event?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  test('screenView produces a screen_view event carrying the screen property', async () => {
    const { client, calls } = build();
    client.screenView('HomeScreen');
    await client.flush();

    expect(calls[0]?.body.events[0]).toMatchObject({
      event_type: 'screen_view',
      properties: { screen: 'HomeScreen' },
    });
  });

  test('omits properties entirely when none are given', async () => {
    const { client, calls } = build();
    client.track('app_open');
    await client.flush();

    expect(calls[0]?.body.events[0]).not.toHaveProperty('properties');
  });
});

describe('queue cap', () => {
  test('caps at 500 events, dropping the oldest on overflow', async () => {
    const { client, calls } = build({ maxBatchSize: 100 });
    for (let n = 0; n <= 500; n++) client.track('e', { n }); // 501 events
    await client.flush();

    const events = allEvents(calls);
    expect(events).toHaveLength(500);
    const markers = events.map((e) => (e.properties as { n: number }).n);
    expect(markers).not.toContain(0); // oldest dropped
    expect(markers).toContain(500); // newest kept
  });
});

describe('flush', () => {
  test('POSTs {product_id, events} with the X-App-Context + content-type headers', async () => {
    const { client, calls } = build();
    client.track('e');
    await client.flush();

    const call = calls[0];
    expect(call?.url).toBe('https://ingest.test/events');
    expect(call?.body.product_id).toBe('clipcast');
    expect(call?.headers[APP_CONTEXT_HEADER]).toBe(JSON.stringify(APP_CONTEXT));
    expect(call?.headers['content-type']).toBe('application/json');
  });

  test('merges host-supplied auth headers from getHeaders()', async () => {
    const { client, calls } = build({ getHeaders: () => ({ Authorization: 'Bearer xyz' }) });
    client.track('e');
    await client.flush();

    expect(calls[0]?.headers.Authorization).toBe('Bearer xyz');
    expect(calls[0]?.headers[APP_CONTEXT_HEADER]).toBeDefined();
  });

  test('clears sent events on success; a second flush is a no-op', async () => {
    const { client, calls } = build();
    client.track('a');
    client.track('b');
    await client.flush();
    await client.flush();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.body.events).toHaveLength(2);
  });

  test('an empty-queue flush makes no request', async () => {
    const { client, calls } = build();
    await client.flush();
    expect(calls).toHaveLength(0);
  });

  test('drops the batch on a non-429 4xx without retrying', async () => {
    const { fetchFn, calls } = makeFetch([{ status: 400 }]);
    const { client } = build({}, { fetch: fetchFn });
    client.track('e');
    await client.flush();
    await client.flush(); // no second attempt — the batch was dropped

    expect(calls).toHaveLength(1);
  });

  test('concurrent flush() calls coalesce onto one in-flight request', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const calls: RecordedCall[] = [];
    const fetchFn = (async (
      url: string,
      opts: { headers: Record<string, string>; body: string },
    ) => {
      calls.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
      await gate;
      return { ok: true, status: 202, headers: { get: () => null } };
    }) as unknown as typeof fetch;

    const { client } = build({}, { fetch: fetchFn });
    client.track('e');
    const p1 = client.flush();
    const p2 = client.flush();
    expect(p1).toBe(p2); // same in-flight promise
    release();
    await Promise.all([p1, p2]);
    expect(calls).toHaveLength(1); // exactly one POST, no double-send
  });
});

describe('flush triggers', () => {
  test('the flush timer fires a flush', async () => {
    const { client, calls, timer } = build();
    client.track('e');
    timer.fire();
    await tick();
    expect(calls).toHaveLength(1);
  });

  test('reaching maxBatchSize triggers a flush without a manual call', async () => {
    const { client, calls } = build({ maxBatchSize: 3 });
    client.track('a');
    client.track('b');
    client.track('c'); // crosses the threshold
    await tick();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body.events).toHaveLength(3);
  });
});

describe('getContextHeaders', () => {
  test('returns the X-App-Context header', () => {
    const { client } = build();
    expect(client.getContextHeaders()).toEqual({
      [APP_CONTEXT_HEADER]: JSON.stringify(APP_CONTEXT),
    });
  });
});

describe('drain loop (chunking under the server cap)', () => {
  test('drains a 500-event backlog in chunks of maxBatchSize', async () => {
    const { fetchFn, calls } = makeFetch();
    const { client } = build({ maxBatchSize: 50 }, { fetch: fetchFn });
    for (let n = 0; n < 500; n++) client.track('e', { n });
    await client.flush();

    expect(allEvents(calls)).toHaveLength(500);
    for (const c of calls) expect(c.body.events.length).toBeLessThanOrEqual(50);
    await client.flush();
    expect(calls).toHaveLength(10); // 500 / 50, queue drained, no extra POST
  });

  test('stops at the first failed chunk and re-queues the remainder', async () => {
    const { fetchFn, calls } = makeFetch([{ status: 202 }, { status: 202 }, { status: 500 }]);
    const { client } = build({ maxBatchSize: 50 }, { fetch: fetchFn });
    for (let n = 0; n < 120; n++) client.track('e', { n });
    await client.flush();
    expect(calls).toHaveLength(3); // chunks 1,2 sent; chunk 3 hit 500 → stop
    expect(allEvents(calls.slice(0, 2))).toHaveLength(100);
  });
});

describe('requeue eviction direction (drop-oldest under a full queue)', () => {
  test('a failed batch re-queued into a full queue keeps its NEWEST events', async () => {
    // Gate the first POST so we can track() the queue up to the cap WHILE the failing
    // batch is in flight. When it fails (5xx) and re-queues to the front, room is smaller
    // than the batch → drop-oldest must keep the batch tail (newest), not its head.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const calls: RecordedCall[] = [];
    let first = true;
    const fetchFn = (async (
      url: string,
      opts: { headers: Record<string, string>; body: string },
    ) => {
      calls.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
      if (first) {
        first = false;
        await gate;
        return { ok: false, status: 500, headers: { get: () => null } };
      }
      return { ok: true, status: 202, headers: { get: () => null } };
    }) as unknown as typeof fetch;

    const { client } = build({ maxBatchSize: 50 }, { fetch: fetchFn });
    // Batch in flight = events 0..49 (the failing chunk).
    for (let n = 0; n < 50; n++) client.track('e', { n });
    const flushing = client.flush();
    await tick(); // let the first POST start and block on the gate
    // Fill the queue to 475 while the batch is in flight → room = 500-475 = 25 on re-queue.
    for (let n = 50; n < 525; n++) client.track('e', { n });
    release();
    await flushing; // batch [0..49] fails → re-queue front with room < 50

    await client.flush(); // drain the rest against the healthy endpoint
    // calls[0] is the FAILED POST (still recorded) — only later POSTs are real deliveries.
    const delivered = new Set(
      allEvents(calls.slice(1)).map((e) => (e.properties as { n: number }).n),
    );
    // The failing batch's NEWEST events (closest to 49) survive the re-queue; oldest (0) drop.
    expect(delivered.has(49)).toBe(true);
    expect(delivered.has(25)).toBe(true);
    expect(delivered.has(24)).toBe(false);
    expect(delivered.has(0)).toBe(false);
  });
});

describe('retry (network / 5xx)', () => {
  test('network failure re-queues once, then drops on the second failure', async () => {
    const { fetchFn, calls } = makeFetch([{ throw: true }]);
    const { client } = build({}, { fetch: fetchFn });
    client.track('e');
    await client.flush(); // throws → re-queued (attempt 1)
    await client.flush(); // throws → dropped (attempt 2)
    await client.flush(); // queue empty → no-op
    expect(calls).toHaveLength(2);
  });

  test('5xx re-queues once, then drops on the second failure', async () => {
    const { fetchFn, calls } = makeFetch([{ status: 500 }]);
    const { client } = build({}, { fetch: fetchFn });
    client.track('e');
    await client.flush();
    await client.flush();
    await client.flush();
    expect(calls).toHaveLength(2);
  });

  test('delivers on the retry when the second attempt succeeds', async () => {
    const { fetchFn, calls } = makeFetch([{ throw: true }, { status: 202 }]);
    const { client } = build({}, { fetch: fetchFn });
    client.track('e', { keep: true });
    await client.flush();
    await client.flush();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body.events[0]).toMatchObject({ properties: { keep: true } });
  });
});

describe('429 / Retry-After backpressure', () => {
  test('pauses flushing until Retry-After elapses, then delivers', async () => {
    const clock = makeClock();
    const { fetchFn, calls } = makeFetch([{ status: 429, retryAfter: 30 }, { status: 202 }]);
    const { client } = build({}, { fetch: fetchFn, now: clock.now });
    client.track('e');
    await client.flush(); // 429 → re-queued, paused 30s
    await client.flush(); // still paused → no POST
    expect(calls).toHaveLength(1);
    clock.advance(30_000);
    await client.flush(); // pause elapsed → retry succeeds
    expect(calls).toHaveLength(2);
    expect(allEvents(calls.slice(1))).toHaveLength(1);
  });

  test('does NOT consume the retry budget (survives repeated 429s)', async () => {
    const clock = makeClock();
    const { fetchFn, calls } = makeFetch([
      { status: 429, retryAfter: 1 },
      { status: 429, retryAfter: 1 },
      { status: 202 },
    ]);
    const { client } = build({}, { fetch: fetchFn, now: clock.now });
    client.track('e');
    await client.flush();
    clock.advance(1000);
    await client.flush();
    clock.advance(1000);
    await client.flush();
    expect(calls).toHaveLength(3); // two 429s then delivered — never dropped
  });

  test('a 429 with no Retry-After retries on the next flush (no extra pause)', async () => {
    const clock = makeClock();
    const { fetchFn, calls } = makeFetch([{ status: 429 }, { status: 202 }]);
    const { client } = build({}, { fetch: fetchFn, now: clock.now });
    client.track('e');
    await client.flush();
    await client.flush();
    expect(calls).toHaveLength(2);
  });
});

describe('storage adapter (durable outbound queue)', () => {
  test('restores a pending queue from storage on construction', async () => {
    const store = makeStorage([{ eventType: 'restored' }]);
    const { fetchFn, calls } = makeFetch();
    const { client } = build({ storage: store.adapter }, { fetch: fetchFn });
    await client.flush();
    expect(calls[0]?.body.events[0]?.event_type).toBe('restored');
  });

  test('persists the queue on enqueue', async () => {
    const store = makeStorage();
    const { client } = build({ storage: store.adapter });
    client.track('e');
    await tick();
    expect(store.saved.at(-1)).toEqual([expect.objectContaining({ eventType: 'e' })]);
  });

  test('clears storage after a flush empties the queue', async () => {
    const store = makeStorage();
    const { client } = build({ storage: store.adapter });
    client.track('e');
    await client.flush();
    expect(store.cleared).toBeGreaterThan(0);
  });

  test('a track() racing a deferred restore does not drop restored events from storage', async () => {
    // Deferred load: track() lands (and persists) BEFORE restore resolves. The storage
    // chain must order restore-merge → its own save → the track save, so the final
    // persisted snapshot contains BOTH the restored and the tracked event.
    const store = makeStorage(null as unknown as Array<{ eventType: string }>);
    const { client } = build({ storage: store.adapter });
    client.track('tracked'); // persists [tracked] onto the chain (queued behind restore)
    store.resolveLoad([{ eventType: 'restored' }]);
    await tick();
    await tick();
    const last = store.saved.at(-1) ?? [];
    const types = last.map((e) => e.eventType);
    expect(types).toContain('restored');
    expect(types).toContain('tracked');
  });

  test('a synchronous track burst coalesces persists — one save captures the whole burst', async () => {
    // Without coalescing, every track() chains its own save: a burst toward the
    // 500 cap re-serializes the whole queue per event (O(N^2) total). The pending
    // link snapshots the queue when it RUNS, so one save can cover the burst.
    const store = makeStorage();
    const { client } = build({ storage: store.adapter, maxBatchSize: 100 });
    const savesBefore = store.saved.length;
    for (let n = 0; n < 99; n++) client.track('burst', { n }); // < maxBatchSize: no flush fires
    await tick();
    await tick();
    expect(store.saved.length - savesBefore).toBeLessThanOrEqual(2); // coalesced, not 99
    expect(store.saved.at(-1)).toHaveLength(99); // and nothing was lost
  });

  test('E2E: an offline burst of 200 events persists sub-linearly and all reach the endpoint on flush', async () => {
    const store = makeStorage();
    const { fetchFn, calls } = makeFetch();
    const { client } = build({ storage: store.adapter, maxBatchSize: 100 }, { fetch: fetchFn });
    for (let n = 0; n < 200; n++) client.track('burst', { n });
    await client.flush();
    expect(allEvents(calls)).toHaveLength(200); // every burst event was delivered
    expect(store.saved.length).toBeLessThan(10); // sub-linear in N, not one save per track
    await tick();
    expect(store.cleared).toBeGreaterThan(0); // durable store cleared once drained
  });

  test('a track landing after a queued clear is not lost to a coalesced-away persist', async () => {
    // Regression (code-review confirmed): with a slow save backing up the chain,
    // [persist pending] -> flush drains -> clearStore queued -> track C skipped by
    // coalescing -> pending persist saves [C] -> clear WIPES it. clearStore must
    // reset the coalescing flag so C queues a fresh save after the clear.
    const ops: string[] = [];
    let saves = 0;
    let releaseSlowSave: (() => void) | undefined;
    const adapter: BeaconStorageAdapter = {
      load: async () => [],
      save: async (events) => {
        saves += 1;
        if (saves === 2) {
          // The first post-restore persist runs slow, backing up the chain.
          await new Promise<void>((r) => {
            releaseSlowSave = r;
          });
        }
        ops.push(`save:${events.map((e) => e.eventType).join(',')}`);
      },
      clear: async () => {
        ops.push('clear');
      },
    };
    const { fetchFn } = makeFetch();
    const { client } = build({ storage: adapter }, { fetch: fetchFn });
    await tick(); // restore completes (save #1, instant)
    client.track('a');
    await tick(); // a's persist link starts running and BLOCKS (save #2)
    client.track('b'); // queues a pending persist link; coalescing flag is set
    const flushing = client.flush(); // drains a+b, queues clearStore behind the pending link
    await tick();
    client.track('c'); // must NOT be coalesced away across the queued clear
    releaseSlowSave?.();
    await flushing;
    for (let i = 0; i < 6; i++) await tick(); // drain the storage chain
    const lastSave = ops.filter((o) => o.startsWith('save:')).at(-1);
    expect(lastSave).toBe('save:c'); // c survives in the durable store...
    expect(ops.lastIndexOf(lastSave as string)).toBeGreaterThan(ops.indexOf('clear')); // ...AFTER the clear
  });

  test('flush awaits restore — events loaded mid-flush are still sent', async () => {
    const store = makeStorage(null as unknown as Array<{ eventType: string }>); // deferred load
    const { fetchFn, calls } = makeFetch();
    const { client } = build({ storage: store.adapter }, { fetch: fetchFn });
    const flushing = client.flush(); // starts before load resolves
    store.resolveLoad([{ eventType: 'restored' }]);
    await flushing;
    expect(calls[0]?.body.events[0]?.event_type).toBe('restored');
  });
});

describe('shutdown', () => {
  test('clears the queue, cancels the timer, and clears storage', async () => {
    const store = makeStorage();
    const { fetchFn, calls } = makeFetch();
    const { client, timer } = build({ storage: store.adapter }, { fetch: fetchFn });
    client.track('e');
    client.shutdown();
    expect(timer.cleared).toBe(true);
    await tick(); // storage ops are serialized on the chain — let the clear() link run
    expect(store.cleared).toBeGreaterThan(0);
    await client.flush(); // queue cleared → no-op
    expect(calls).toHaveLength(0);
  });
});

describe('flushViaBeacon (unload transport seam)', () => {
  test('sends one batch through the transport and clears it on success', () => {
    const { client } = build();
    client.track('a');
    client.track('b');
    const sends: Array<{ url: string; body: string }> = [];
    const ok = client.flushViaBeacon((url, body) => {
      sends.push({ url, body });
      return true;
    });

    expect(ok).toBe(true);
    expect(sends).toHaveLength(1);
    expect(sends[0]?.url).toBe('https://ingest.test/events');
    const payload = JSON.parse(sends[0]?.body ?? '{}');
    expect(payload.product_id).toBe('clipcast');
    expect(payload.events.map((e: { event_type: string }) => e.event_type)).toEqual(['a', 'b']);

    // queue cleared → a second beacon is a no-op
    let secondCalled = false;
    client.flushViaBeacon(() => {
      secondCalled = true;
      return true;
    });
    expect(secondCalled).toBe(false);
  });

  test('keeps the queue when the transport reports failure', () => {
    const { client } = build();
    client.track('a');
    expect(client.flushViaBeacon(() => false)).toBe(false);

    // still queued → a successful beacon now delivers it
    let delivered = '{}';
    client.flushViaBeacon((_url, body) => {
      delivered = body;
      return true;
    });
    expect(JSON.parse(delivered).events).toHaveLength(1);
  });

  test('an empty-queue beacon is a no-op that returns true', () => {
    const { client } = build();
    let called = false;
    const ok = client.flushViaBeacon(() => {
      called = true;
      return true;
    });
    expect(ok).toBe(true);
    expect(called).toBe(false);
  });

  test('sends at most maxBatchSize events in one beacon (server cap)', () => {
    // Gate the size-triggered flush so its drain hangs on the in-flight fetch and CANNOT splice
    // the queue before the synchronous beacon reads it. Without the gate the beacon's cap of 3
    // would hold only because nothing is awaited — this makes it hold regardless.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const fetchFn = (async () => {
      await gate;
      return { ok: true, status: 202, headers: { get: () => null } };
    }) as unknown as typeof fetch;
    const { client } = build({ maxBatchSize: 3 }, { fetch: fetchFn });
    for (let n = 0; n < 10; n++) client.track('e', { n });
    let count = -1;
    client.flushViaBeacon((_url, body) => {
      count = JSON.parse(body).events.length;
      return true;
    });
    expect(count).toBe(3);
    release();
  });

  test('no event is delivered twice when a beacon fires during an in-flight flush', async () => {
    // Lock the no-double-send property flushViaBeacon's doc comment motivates: drain() splices
    // its batch out BEFORE awaiting the fetch, so a beacon racing in sees a disjoint tail.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const fetchCalls: RecordedCall[] = [];
    const fetchFn = (async (
      url: string,
      opts: { headers: Record<string, string>; body: string },
    ) => {
      fetchCalls.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
      await gate;
      return { ok: true, status: 202, headers: { get: () => null } };
    }) as unknown as typeof fetch;
    const { client } = build({ maxBatchSize: 3 }, { fetch: fetchFn });
    for (let n = 0; n < 6; n++) client.track('e', { n });

    const flushing = client.flush(); // drain splices [0,1,2] out, then blocks on the gate
    await tick();
    const beaconBodies: string[] = [];
    client.flushViaBeacon((_url, body) => {
      beaconBodies.push(body);
      return true;
    });
    release();
    await flushing;
    await client.flush(); // drain anything the beacon did not take

    const fetched = allEvents(fetchCalls).map((e) => (e.properties as { n: number }).n);
    const beaconed = beaconBodies.flatMap((b) =>
      (JSON.parse(b).events as Array<{ properties: { n: number } }>).map((e) => e.properties.n),
    );
    const all = [...fetched, ...beaconed];
    expect(new Set(all).size).toBe(all.length); // every n delivered at most once
    expect(beaconed).toEqual([3, 4, 5]); // beacon saw only the disjoint tail
  });
});

describe('delivery callbacks (onSent / onDrop / onError)', () => {
  test('onDrop fires with the batch events on a non-429 4xx and does not retry', async () => {
    const dropped: Array<{ events: BeaconEvent[]; status?: number }> = [];
    const { fetchFn, calls } = makeFetch([{ status: 403 }]); // story-006 allowlist rejection
    const { client } = build(
      { onDrop: (events, info) => dropped.push({ events, status: info.status }) },
      { fetch: fetchFn },
    );
    client.track('e');
    await client.flush();
    await client.flush(); // no retry — a rejected batch is discarded, not re-queued

    expect(calls).toHaveLength(1);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.status).toBe(403);
    expect(dropped[0]?.events.map((e) => e.eventType)).toEqual(['e']);
  });

  test('onError fires with the status on a 5xx and the events are retained', async () => {
    const errors: Array<{ status?: number; error?: unknown }> = [];
    const { fetchFn, calls } = makeFetch([{ status: 500 }, { status: 202 }]);
    const { client } = build({ onError: (_e, info) => errors.push(info) }, { fetch: fetchFn });
    client.track('e');
    await client.flush(); // 500 → onError, re-queued
    await client.flush(); // 202 → delivered the retained event

    expect(errors).toHaveLength(1);
    expect(errors[0]?.status).toBe(500);
    expect(allEvents(calls)).toHaveLength(2); // original attempt + retry
  });

  test('onError fires with the thrown error on a network failure', async () => {
    const errors: Array<{ status?: number; error?: unknown }> = [];
    const { fetchFn } = makeFetch([{ throw: true }]);
    const { client } = build({ onError: (_e, info) => errors.push(info) }, { fetch: fetchFn });
    client.track('e');
    await client.flush();

    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toBeInstanceOf(Error);
    expect(errors[0]?.status).toBeUndefined();
  });

  test('onSent surfaces product_id_used parsed from the 202 body', async () => {
    const sent: Array<{ productIdUsed?: string }> = [];
    const { fetchFn } = makeFetch([{ status: 202, productIdUsed: 'other-app' }]);
    const { client } = build({ onSent: (_e, info) => sent.push(info) }, { fetch: fetchFn });
    client.track('e');
    await client.flush();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.productIdUsed).toBe('other-app');
  });

  test('a throwing host callback does not break the drain', async () => {
    const { fetchFn, calls } = makeFetch([{ status: 403 }]);
    const { client } = build(
      {
        onDrop: () => {
          throw new Error('host callback boom');
        },
      },
      { fetch: fetchFn },
    );
    client.track('e');
    await expect(client.flush()).resolves.toBeUndefined(); // drain completes despite the throw

    expect(calls).toHaveLength(1);
  });

  test('onDrop fires with info.exhausted when a batch exhausts its retries', async () => {
    const dropped: Array<{
      events: BeaconEvent[];
      info: { status?: number; exhausted?: boolean };
    }> = [];
    const errors: Array<{ status?: number; error?: unknown }> = [];
    const { fetchFn, calls } = makeFetch([{ status: 500 }]); // always 5xx → transient
    const { client } = build(
      {
        onError: (_e, info) => errors.push(info),
        onDrop: (events, info) => dropped.push({ events, info }),
      },
      { fetch: fetchFn },
    );
    client.track('e', { keep: true });
    await client.flush(); // 500 → onError, re-queued (attempt 1)
    await client.flush(); // 500 → onError, attempt 2 == MAX → dropped → onDrop{exhausted}
    await client.flush(); // queue empty → no further POST or callback

    expect(calls).toHaveLength(2); // original attempt + the one retry, then exhausted
    expect(errors).toHaveLength(2); // onError on BOTH failing attempts (no regression)
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.info.exhausted).toBe(true);
    expect(dropped[0]?.info.status).toBeUndefined(); // exhaustion drop has no HTTP status
    expect(dropped[0]?.events.map((e) => e.eventType)).toEqual(['e']);
    expect(dropped[0]?.events[0]?.properties).toEqual({ keep: true });
  });

  test('a throwing onDrop on retry exhaustion does not break the drain', async () => {
    const { fetchFn } = makeFetch([{ status: 500 }]);
    const { client } = build(
      {
        onDrop: () => {
          throw new Error('host callback boom');
        },
      },
      { fetch: fetchFn },
    );
    client.track('e');
    await client.flush(); // attempt 1 → re-queued
    await expect(client.flush()).resolves.toBeUndefined(); // attempt 2 exhausts → onDrop throws, drain still resolves
  });
});

describe('onDrop on queue overflow (reason: overflow)', () => {
  type OverflowDrop = { events: BeaconEvent[]; reason?: string };
  const markers = (d: OverflowDrop) => d.events.map((e) => (e.properties as { n: number }).n);

  // A fetch whose FIRST POST blocks on a gate then resolves to `failResponse` (so the queue can
  // be filled past the cap while that batch is in flight); every later POST succeeds (202).
  type FakeResponse = { ok: boolean; status: number; headers: { get: () => string | null } };
  function gatedFetch(failResponse: FakeResponse): { fetchFn: typeof fetch; release: () => void } {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let first = true;
    const fetchFn = (async () => {
      if (first) {
        first = false;
        await gate;
        return failResponse;
      }
      return { ok: true, status: 202, headers: { get: () => null } };
    }) as unknown as typeof fetch;
    return { fetchFn, release };
  }

  test('track() into a full queue fires onDrop{reason:overflow} with the evicted oldest event', () => {
    const dropped: OverflowDrop[] = [];
    // maxBatchSize 100 keeps the synchronous track loop from auto-flushing mid-fill
    // (flush is async and can't run until the loop yields), so the queue truly fills to 500.
    const { client } = build({
      maxBatchSize: 100,
      onDrop: (events, info) => dropped.push({ events, reason: info.reason }),
    });
    for (let n = 0; n < 501; n++) client.track('e', { n }); // 1 over the 500 cap → evict n=0

    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.reason).toBe('overflow');
    expect(markers(dropped[0] as OverflowDrop)).toEqual([0]); // the single oldest event
    client.shutdown();
  });

  test('a throwing onDrop on a track() overflow does not break track()', () => {
    const { client } = build({
      maxBatchSize: 100,
      onDrop: () => {
        throw new Error('host callback boom');
      },
    });
    expect(() => {
      for (let n = 0; n < 501; n++) client.track('e', { n });
    }).not.toThrow();
    client.shutdown();
  });

  test('a failed batch re-queued past the cap fires onDrop{reason:overflow} for its dropped oldest', async () => {
    // Mirror the eviction-direction test: gate the failing POST, fill the queue while it is in
    // flight so room < batch on re-queue, then assert the dropped oldest surface via onDrop.
    const { fetchFn, release } = gatedFetch({
      ok: false,
      status: 500,
      headers: { get: () => null },
    });

    const dropped: OverflowDrop[] = [];
    const { client } = build(
      { maxBatchSize: 50, onDrop: (events, info) => dropped.push({ events, reason: info.reason }) },
      { fetch: fetchFn },
    );
    for (let n = 0; n < 50; n++) client.track('e', { n }); // failing batch 0..49
    const flushing = client.flush();
    await tick(); // first POST starts and blocks on the gate
    for (let n = 50; n < 525; n++) client.track('e', { n }); // fill to 475 → room = 25 on re-queue
    release();
    await flushing; // batch [0..49] fails → re-queue front, drop the 25 oldest

    const overflow = dropped.filter((d) => d.reason === 'overflow');
    expect(overflow).toHaveLength(1);
    expect(markers(overflow[0] as OverflowDrop)).toEqual([...Array(25).keys()]); // n=0..24 dropped
    client.shutdown();
  });

  test('a 429-paused batch re-queued past the cap fires onDrop{reason:overflow} for its dropped oldest', async () => {
    const { fetchFn, release } = gatedFetch({
      ok: false,
      status: 429,
      headers: { get: () => '1' }, // Retry-After: 1s
    });

    const dropped: OverflowDrop[] = [];
    const { client } = build(
      { maxBatchSize: 50, onDrop: (events, info) => dropped.push({ events, reason: info.reason }) },
      { fetch: fetchFn },
    );
    for (let n = 0; n < 50; n++) client.track('e', { n }); // paused batch 0..49
    const flushing = client.flush();
    await tick();
    for (let n = 50; n < 525; n++) client.track('e', { n }); // fill to 475 → room = 25 on re-queue
    release();
    await flushing; // 429 → re-queue front WITHOUT consuming an attempt, drop the 25 oldest

    const overflow = dropped.filter((d) => d.reason === 'overflow');
    expect(overflow).toHaveLength(1);
    expect(markers(overflow[0] as OverflowDrop)).toEqual([...Array(25).keys()]); // n=0..24 dropped
    client.shutdown();
  });

  test('restoring a persisted queue past the cap fires onDrop{reason:overflow} for the trimmed oldest', async () => {
    const dropped: OverflowDrop[] = [];
    const seed = Array.from({ length: 501 }, (_, n) => ({ eventType: 'e', properties: { n } }));
    const storage = makeStorage(seed);
    const { client } = build({
      storage: storage.adapter,
      onDrop: (events, info) => dropped.push({ events, reason: info.reason }),
    });
    await tick(); // let the restore storage-chain merge + trim settle

    const overflow = dropped.filter((d) => d.reason === 'overflow');
    expect(overflow).toHaveLength(1);
    expect(markers(overflow[0] as OverflowDrop)).toEqual([0]); // oldest restored event trimmed
    client.shutdown();
  });
});
