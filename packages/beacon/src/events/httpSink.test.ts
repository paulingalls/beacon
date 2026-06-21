import { describe, expect, mock, test } from 'bun:test';

import type { BeaconEvent } from '../types';
import { HttpSink } from './httpSink';

const ENDPOINT = 'https://beacon.example/analytics/events';
const TOKEN = 'super-secret-trusted-token';

/** A fetch double that records calls and returns a scriptable Response. */
function fakeFetch(status = 202) {
  const calls: { url: string; init: RequestInit }[] = [];
  let nextStatus = status;
  let throwOnce = false;
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (throwOnce) {
      throwOnce = false;
      throw new Error('network down');
    }
    return new Response(null, { status: nextStatus });
  }) as unknown as typeof fetch;
  return {
    fn,
    calls,
    setStatus: (s: number) => {
      nextStatus = s;
    },
    throwNext: () => {
      throwOnce = true;
    },
  };
}

function sink(
  fetchImpl: typeof fetch,
  opts: { maxRetries?: number; maxBufferSize?: number; maxBatchSize?: number } = {},
) {
  return new HttpSink({
    endpoint: ENDPOINT,
    trustedIngestToken: TOKEN,
    productId: 'clipcast',
    fetch: fetchImpl,
    ...opts,
  });
}

function evt(over: Partial<BeaconEvent> = {}): BeaconEvent {
  return { productId: 'clipcast', eventType: 'tap', ...over };
}

function bodyOf(call: { init: RequestInit }): Record<string, unknown> {
  return JSON.parse(call.init.body as string);
}
function headersOf(call: { init: RequestInit }): Record<string, string> {
  return call.init.headers as Record<string, string>;
}
/** Definite indexed access (tsconfig has noUncheckedIndexedAccess). */
function nth(ff: { calls: { url: string; init: RequestInit }[] }, i: number) {
  const c = ff.calls[i];
  if (!c) throw new Error(`no fetch call at index ${i}`);
  return c;
}

describe('HttpSink wire shape', () => {
  test('POSTs to the endpoint with a Bearer auth header and JSON content-type', async () => {
    const ff = fakeFetch();
    const s = sink(ff.fn);
    s.push(evt({ eventType: 'page_view' }));
    await s.flush();

    expect(ff.calls).toHaveLength(1);
    expect(nth(ff, 0).url).toBe(ENDPOINT);
    expect(nth(ff, 0).init.method).toBe('POST');
    const h = headersOf(nth(ff, 0));
    expect(h.authorization).toBe(`Bearer ${TOKEN}`);
    expect(h['content-type']).toBe('application/json');
  });

  test('envelope carries product_id + visitor_token; events use snake_case wire shape with ISO timestamp', async () => {
    const ff = fakeFetch();
    const s = sink(ff.fn);
    s.push(
      evt({
        eventType: 'purchase',
        properties: { sku: 'x1' },
        timestamp: new Date('2026-01-02T03:04:05.000Z'),
        userId: 'user-9',
        visitorToken: 'v1',
        context: { user_agent: 'UA/1' },
      }),
    );
    await s.flush();

    const body = bodyOf(nth(ff, 0));
    expect(body.product_id).toBe('clipcast');
    expect(body.visitor_token).toBe('v1');
    expect(body.events).toEqual([
      {
        event_type: 'purchase',
        properties: { sku: 'x1' },
        timestamp: '2026-01-02T03:04:05.000Z',
        user_id: 'user-9',
        context: { user_agent: 'UA/1' },
      },
    ]);
  });

  test('omits visitor_token from the envelope when the event has none', async () => {
    const ff = fakeFetch();
    const s = sink(ff.fn);
    s.push(evt({ userId: 'user-1' })); // authenticated, no visitor token
    await s.flush();
    expect('visitor_token' in bodyOf(nth(ff, 0))).toBe(false);
  });
});

describe('HttpSink visitor_token grouping', () => {
  test('splits a batch into one POST per distinct visitor_token', async () => {
    const ff = fakeFetch();
    const s = sink(ff.fn);
    s.push(evt({ eventType: 'a', visitorToken: 'v1' }));
    s.push(evt({ eventType: 'b', visitorToken: 'v2' }));
    s.push(evt({ eventType: 'c', visitorToken: 'v1' }));
    await s.flush();

    expect(ff.calls).toHaveLength(2);
    const byToken = new Map(ff.calls.map((c) => [bodyOf(c).visitor_token, bodyOf(c)]));
    expect((byToken.get('v1')?.events as unknown[]).length).toBe(2);
    expect((byToken.get('v2')?.events as unknown[]).length).toBe(1);
  });
});

describe('HttpSink success + stats', () => {
  test('a 2xx clears the queue and counts flushed', async () => {
    const ff = fakeFetch(202);
    const s = sink(ff.fn);
    s.push(evt());
    s.push(evt({ visitorToken: 'v1' }));
    await s.flush();
    expect(s.stats()).toMatchObject({ buffered: 0, flushed: 2, dropped: 0, retryFailures: 0 });
  });
});

describe('HttpSink failure handling', () => {
  test('a 4xx drops the batch loudly (no retry) and counts retryFailures', async () => {
    const ff = fakeFetch();
    ff.setStatus(403); // bad token / non-allowlisted product
    const warn = mock((..._args: unknown[]) => {});
    const orig = console.warn;
    console.warn = warn as unknown as typeof console.warn;
    try {
      const s = sink(ff.fn);
      s.push(evt());
      await s.flush();
      expect(ff.calls).toHaveLength(1); // not retried
      expect(s.stats()).toMatchObject({ buffered: 0, retryFailures: 1, flushed: 0 });
      // status surfaced, token NEVER logged
      const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('403');
      expect(logged).not.toContain(TOKEN);
    } finally {
      console.warn = orig;
    }
  });

  test('a 3xx (misconfigured endpoint) is dropped loudly, not retried', async () => {
    const ff = fakeFetch();
    ff.setStatus(301); // redirect fetch did not auto-follow — a config error
    const warn = mock((..._args: unknown[]) => {});
    const orig = console.warn;
    console.warn = warn as unknown as typeof console.warn;
    try {
      const s = sink(ff.fn);
      s.push(evt());
      await s.flush();
      expect(ff.calls).toHaveLength(1); // not retried
      expect(s.stats()).toMatchObject({ buffered: 0, retryFailures: 1, flushed: 0 });
      const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('301');
      expect(logged).not.toContain(TOKEN);
    } finally {
      console.warn = orig;
    }
  });

  test('a 5xx requeues for retry; events survive in the buffer', async () => {
    const ff = fakeFetch();
    ff.setStatus(503);
    const s = sink(ff.fn);
    s.push(evt());
    await s.flush();
    expect(s.stats()).toMatchObject({ buffered: 1, flushed: 0, retryFailures: 0 });
  });

  test('a network error requeues for retry', async () => {
    const ff = fakeFetch();
    ff.throwNext();
    const s = sink(ff.fn);
    s.push(evt());
    await s.flush();
    expect(s.stats().buffered).toBe(1);
  });

  test('drops after maxRetries exhausted (counts retryFailures)', async () => {
    const ff = fakeFetch();
    ff.setStatus(503);
    const s = sink(ff.fn, { maxRetries: 2 });
    s.push(evt());
    await s.flush(); // attempt 1 -> requeue
    await s.flush(); // attempt 2 -> exhausted, drop
    expect(s.stats()).toMatchObject({ buffered: 0, retryFailures: 1 });
  });

  test('never logs the token on a 5xx retry', async () => {
    const ff = fakeFetch();
    ff.setStatus(500);
    const warn = mock((..._args: unknown[]) => {});
    const orig = console.warn;
    console.warn = warn as unknown as typeof console.warn;
    try {
      const s = sink(ff.fn);
      s.push(evt());
      await s.flush();
      const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).not.toContain(TOKEN);
    } finally {
      console.warn = orig;
    }
  });
});

describe('HttpSink backpressure', () => {
  test('drops silently (counted) when the buffer is full', () => {
    const ff = fakeFetch();
    const s = sink(ff.fn, { maxBufferSize: 2 });
    s.push(evt());
    s.push(evt());
    s.push(evt()); // over capacity
    expect(s.stats()).toMatchObject({ buffered: 2, dropped: 1 });
  });
});
