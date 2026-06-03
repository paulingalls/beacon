import { describe, expect, test } from 'bun:test';

import { APP_CONTEXT_HEADER, type AppContext } from '../context/appContext';
import { BeaconClient } from './client';
import type { BeaconClientConfig, BeaconClientDeps } from './types';

const APP_CONTEXT: AppContext = { appVersion: '1.0.0', platform: 'ios' };

/** Let all pending microtasks (a fire-and-forget flush chain) settle. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

interface FetchStep {
  status?: number;
  retryAfter?: number | string;
  throw?: boolean;
}
interface RecordedCall {
  url: string;
  headers: Record<string, string>;
  body: { product_id?: string; events: Array<Record<string, unknown>> };
}

/** Scripted fetch stub: records each call, replays `plan` (last step repeats). */
function makeFetch(plan: FetchStep[] = [{ status: 202 }]) {
  const calls: RecordedCall[] = [];
  let i = 0;
  const fetchFn = (async (url: string, opts: { headers: Record<string, string>; body: string }) => {
    calls.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
    const step = plan[Math.min(i, plan.length - 1)] ?? { status: 202 };
    i += 1;
    if (step.throw) throw new Error('network down');
    const status = step.status ?? 202;
    const headers = {
      get: (k: string) =>
        k.toLowerCase() === 'retry-after' && step.retryAfter != null
          ? String(step.retryAfter)
          : null,
    };
    return { ok: status >= 200 && status < 300, status, headers };
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

/** Manual interval scheduler — bun:test has no fake timers. `fire()` runs the handler. */
function makeTimer() {
  let handler: (() => void) | undefined;
  let cleared = false;
  const seam = {
    setInterval: ((h: () => void) => {
      handler = h;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as BeaconClientDeps['setInterval'],
    clearInterval: (() => {
      cleared = true;
    }) as BeaconClientDeps['clearInterval'],
    fire: () => handler?.(),
    get cleared() {
      return cleared;
    },
  };
  return seam;
}

function makeClock(start = 1000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** In-memory storage adapter spy. `loadValue` seeds a restored queue. */
function makeStorage(loadValue: Array<{ eventType: string }> = []) {
  const saved: Array<Array<{ eventType: string }>> = [];
  let cleared = 0;
  let loadResolve: ((v: Array<{ eventType: string }>) => void) | undefined;
  const adapter = {
    load: () =>
      loadValue === null
        ? new Promise<Array<{ eventType: string }>>((r) => {
            loadResolve = r;
          })
        : Promise.resolve(loadValue),
    save: async (events: Array<{ eventType: string }>) => {
      saved.push(events);
    },
    clear: async () => {
      cleared += 1;
    },
  };
  return {
    adapter: adapter as unknown as BeaconClientConfig['storage'],
    get saved() {
      return saved;
    },
    get cleared() {
      return cleared;
    },
    resolveLoad: (v: Array<{ eventType: string }>) => loadResolve?.(v),
  };
}

/** Flatten every event POSTed across all recorded fetch calls. */
function allEvents(calls: RecordedCall[]): Array<Record<string, unknown>> {
  return calls.flatMap((c) => c.body.events);
}

function build(
  config: Partial<BeaconClientConfig> = {},
  deps: BeaconClientDeps = {},
): { client: BeaconClient; calls: RecordedCall[]; timer: ReturnType<typeof makeTimer> } {
  const fetchStub = deps.fetch ? { fetchFn: deps.fetch, calls: [] as RecordedCall[] } : makeFetch();
  const timer = makeTimer();
  const client = new BeaconClient(
    {
      endpoint: 'https://ingest.test/events',
      productId: 'clipcast',
      appContext: APP_CONTEXT,
      ...config,
    },
    {
      fetch: fetchStub.fetchFn,
      setInterval: timer.setInterval,
      clearInterval: timer.clearInterval,
      ...deps,
    },
  );
  return { client, calls: fetchStub.calls, timer };
}

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
