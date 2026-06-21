import { describe, expect, test } from 'bun:test';

import { createHttpBeacon } from './httpBeacon';

const ENDPOINT = 'https://beacon.example/analytics/events';
const TOKEN = 'trusted-token-xyz';

function fakeFetch() {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(null, { status: 202 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function beacon(
  fetchImpl: typeof fetch,
  over: Partial<Parameters<typeof createHttpBeacon>[0]> = {},
) {
  return createHttpBeacon({
    productId: 'clipcast',
    endpoint: ENDPOINT,
    trustedIngestToken: TOKEN,
    fetch: fetchImpl,
    ...over,
  });
}

function lastBody(calls: { init: RequestInit }[]): Record<string, unknown> {
  const c = calls.at(-1);
  if (!c) throw new Error('no fetch call');
  return JSON.parse(c.init.body as string);
}
function firstEvent(body: Record<string, unknown>): Record<string, unknown> {
  return (body.events as Record<string, unknown>[])[0] as Record<string, unknown>;
}

describe('createHttpBeacon.capture', () => {
  test('emits a request event with path/method/status and the _t visitor token', async () => {
    const ff = fakeFetch();
    const b = beacon(ff.fn);
    b.capture(new Request('https://app.example/dashboard?_t=v9'), {
      status: 200,
      responseTimeMs: 12,
    });
    await b.flush();

    const body = lastBody(ff.calls);
    expect(body.product_id).toBe('clipcast');
    expect(body.visitor_token).toBe('v9');
    const ev = firstEvent(body);
    expect(ev.event_type).toBe('request');
    expect(ev.properties).toMatchObject({
      path: '/dashboard',
      method: 'GET',
      status: 200,
      response_time_ms: 12,
    });
  });

  test('sends the Bearer token on the POST', async () => {
    const ff = fakeFetch();
    const b = beacon(ff.fn);
    b.capture(new Request('https://app.example/'));
    await b.flush();
    const h = (ff.calls.at(-1)?.init.headers ?? {}) as Record<string, string>;
    expect(h.authorization).toBe(`Bearer ${TOKEN}`);
  });
});

describe('createHttpBeacon.track', () => {
  test('emits a custom event carrying the resolved user_id under getUserId', async () => {
    const ff = fakeFetch();
    const b = beacon(ff.fn, { getUserId: (req: Request) => req.headers.get('x-user') });
    b.track(
      new Request('https://app.example/buy?_t=v1', { headers: { 'x-user': 'user-42' } }),
      'purchase',
      {
        sku: 'a1',
      },
    );
    await b.flush();

    const ev = firstEvent(lastBody(ff.calls));
    expect(ev.event_type).toBe('purchase');
    expect(ev.user_id).toBe('user-42');
    expect(ev.properties).toEqual({ sku: 'a1' });
  });

  test('throws on an invalid event_type (empty/over-length), pushing nothing', async () => {
    const ff = fakeFetch();
    const b = beacon(ff.fn);
    expect(() => b.track(new Request('https://app.example/'), '   ')).toThrow();
    expect(() => b.track(new Request('https://app.example/'), 'x'.repeat(101))).toThrow();
    await b.flush();
    expect(ff.calls).toHaveLength(0);
  });

  test('a throwing getUserId is failure-isolated to a null user id (§1.3)', async () => {
    const ff = fakeFetch();
    const b = beacon(ff.fn, {
      getUserId: () => {
        throw new Error('auth boom');
      },
    });
    expect(() => b.track(new Request('https://app.example/?_t=v1'), 'tap')).not.toThrow();
    await b.flush();
    const ev = firstEvent(lastBody(ff.calls));
    expect(ev.user_id).toBeUndefined(); // null userId → omitted from the wire
    expect(lastBody(ff.calls).visitor_token).toBe('v1');
  });
});

describe('createHttpBeacon lifecycle', () => {
  test('stats reflects buffered/flushed; shutdown drains', async () => {
    const ff = fakeFetch();
    const b = beacon(ff.fn);
    b.capture(new Request('https://app.example/a?_t=v1'));
    expect(b.stats().buffered).toBe(1);
    await b.shutdown();
    expect(b.stats()).toMatchObject({ buffered: 0, flushed: 1 });
  });
});
