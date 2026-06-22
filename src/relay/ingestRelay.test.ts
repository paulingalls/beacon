import { describe, expect, test } from 'bun:test';

import { createIngestRelay, relayBatch } from './ingestRelay';

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
function eventsOf(call: { init: RequestInit }): Record<string, unknown>[] {
  return bodyOf(call).events as Record<string, unknown>[];
}
function evt(i: number, call: { init: RequestInit }): Record<string, unknown> {
  const e = eventsOf(call)[i];
  if (!e) throw new Error(`no event at index ${i}`);
  return e;
}

const sampleBatch = () => ({
  product_id: 'clipcast',
  visitor_token: 'device-handle',
  events: [
    {
      event_type: 'screen_view',
      timestamp: '2026-06-22T10:00:00.000Z',
      properties: { name: 'Home' },
      context: { app_version: '1.2.3' },
    },
    { event_type: 'tap' },
  ],
});

describe('relayBatch — wire shape under the trusted bearer', () => {
  test('POSTs to the endpoint with Bearer auth + JSON content-type and the envelope product_id/visitor_token', async () => {
    const ff = fakeFetch();
    await relayBatch(sampleBatch(), {
      endpoint: ENDPOINT,
      trustedIngestToken: TOKEN,
      userId: 'user-42',
      fetch: ff.fn,
    });

    expect(ff.calls).toHaveLength(1);
    expect(nth(ff, 0).url).toBe(ENDPOINT);
    expect(nth(ff, 0).init.method).toBe('POST');
    const h = headersOf(nth(ff, 0));
    expect(h.authorization).toBe(`Bearer ${TOKEN}`);
    expect(h['content-type']).toBe('application/json');
    const body = bodyOf(nth(ff, 0));
    expect(body.product_id).toBe('clipcast');
    expect(body.visitor_token).toBe('device-handle');
  });

  test('stamps the host-resolved user_id on every event while preserving timestamp/context/properties', async () => {
    const ff = fakeFetch();
    await relayBatch(sampleBatch(), {
      endpoint: ENDPOINT,
      trustedIngestToken: TOKEN,
      userId: 'user-42',
      fetch: ff.fn,
    });

    const events = eventsOf(nth(ff, 0));
    expect(events).toHaveLength(2);
    expect(evt(0, nth(ff, 0))).toEqual({
      event_type: 'screen_view',
      timestamp: '2026-06-22T10:00:00.000Z',
      properties: { name: 'Home' },
      context: { app_version: '1.2.3' },
      user_id: 'user-42',
    });
    expect(evt(1, nth(ff, 0)).user_id).toBe('user-42');
  });

  test('omits an empty-string product_id rather than forwarding it (allowlist-mode 403 would drop valid events)', async () => {
    const ff = fakeFetch();
    await relayBatch(
      { product_id: '', visitor_token: '', events: [{ event_type: 'tap' }] },
      { endpoint: ENDPOINT, trustedIngestToken: TOKEN, userId: 'u', fetch: ff.fn },
    );
    const body = bodyOf(nth(ff, 0));
    expect('product_id' in body).toBe(false);
    expect('visitor_token' in body).toBe(false);
  });

  test('userId null forwards anonymously (no user_id) but still under the bearer', async () => {
    const ff = fakeFetch();
    await relayBatch(sampleBatch(), {
      endpoint: ENDPOINT,
      trustedIngestToken: TOKEN,
      userId: null,
      fetch: ff.fn,
    });

    expect(headersOf(nth(ff, 0)).authorization).toBe(`Bearer ${TOKEN}`);
    const e0 = evt(0, nth(ff, 0));
    expect(e0.user_id).toBeUndefined();
    expect(e0.event_type).toBe('screen_view');
  });

  test('strips a device-asserted per-event user_id (authed path overwrites, anonymous path drops)', async () => {
    // Authed: the host id wins over a smuggled one.
    const ffAuthed = fakeFetch();
    await relayBatch(
      { product_id: 'clipcast', events: [{ event_type: 'tap', user_id: 'forged-admin' }] },
      { endpoint: ENDPOINT, trustedIngestToken: TOKEN, userId: 'user-42', fetch: ffAuthed.fn },
    );
    expect(evt(0, nth(ffAuthed, 0)).user_id).toBe('user-42');

    // Anonymous: a smuggled user_id never rides the trusted bearer.
    const ffAnon = fakeFetch();
    await relayBatch(
      { product_id: 'clipcast', events: [{ event_type: 'tap', user_id: 'forged-admin' }] },
      { endpoint: ENDPOINT, trustedIngestToken: TOKEN, userId: null, fetch: ffAnon.fn },
    );
    expect(evt(0, nth(ffAnon, 0)).user_id).toBeUndefined();
  });
});

describe('relayBatch — fail-closed', () => {
  test('throws when the trusted token is empty, never forwards, and the message has no token', async () => {
    const ff = fakeFetch();
    let thrown: unknown;
    try {
      await relayBatch(sampleBatch(), {
        endpoint: ENDPOINT,
        trustedIngestToken: '',
        userId: 'user-42',
        fetch: ff.fn,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(ff.calls).toHaveLength(0);
  });
});

describe('relayBatch — outcome mapping (durability: never lose valid events)', () => {
  test('upstream 202 -> ok', async () => {
    const ff = fakeFetch(202);
    const r = await relayBatch(sampleBatch(), {
      endpoint: ENDPOINT,
      trustedIngestToken: TOKEN,
      userId: 'u',
      fetch: ff.fn,
    });
    expect(r).toEqual({ outcome: 'ok', status: 202 });
  });

  test('upstream 400 (malformed batch, device-fault) -> caller_error', async () => {
    const ff = fakeFetch(400);
    const r = await relayBatch(sampleBatch(), {
      endpoint: ENDPOINT,
      trustedIngestToken: TOKEN,
      userId: 'u',
      fetch: ff.fn,
    });
    expect(r).toEqual({ outcome: 'caller_error', status: 400 });
  });

  test('upstream 403 (relay bearer/allowlist fault) -> retryable, NOT dropped', async () => {
    const ff = fakeFetch(403);
    const r = await relayBatch(sampleBatch(), {
      endpoint: ENDPOINT,
      trustedIngestToken: TOKEN,
      userId: 'u',
      fetch: ff.fn,
    });
    expect(r).toEqual({ outcome: 'retryable', status: 403 });
  });

  test('upstream 500 -> retryable', async () => {
    const ff = fakeFetch(500);
    const r = await relayBatch(sampleBatch(), {
      endpoint: ENDPOINT,
      trustedIngestToken: TOKEN,
      userId: 'u',
      fetch: ff.fn,
    });
    expect(r).toEqual({ outcome: 'retryable', status: 500 });
  });

  test('network error -> retryable with status 0', async () => {
    const ff = fakeFetch();
    ff.throwNext();
    const r = await relayBatch(sampleBatch(), {
      endpoint: ENDPOINT,
      trustedIngestToken: TOKEN,
      userId: 'u',
      fetch: ff.fn,
    });
    expect(r).toEqual({ outcome: 'retryable', status: 0 });
  });
});

describe('createIngestRelay — Request -> Response handler', () => {
  function relayReq(batch: unknown): Request {
    return new Request('https://app.example/beacon/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof batch === 'string' ? batch : JSON.stringify(batch),
    });
  }

  test('throws at construction when the trusted token is empty (no token in message)', () => {
    expect(() =>
      createIngestRelay({
        endpoint: ENDPOINT,
        trustedIngestToken: '',
        resolveUserId: () => 'u',
      }),
    ).toThrow();
  });

  test('passes the Request to resolveUserId, stamps the resolved id, and returns 204 on success', async () => {
    const ff = fakeFetch(202);
    let seen: Request | undefined;
    const handler = createIngestRelay({
      endpoint: ENDPOINT,
      trustedIngestToken: TOKEN,
      resolveUserId: (req) => {
        seen = req;
        return 'user-99';
      },
      fetch: ff.fn,
    });

    const res = await handler(relayReq(sampleBatch()));
    expect(res.status).toBe(204);
    expect(seen).toBeInstanceOf(Request);
    expect(evt(0, nth(ff, 0)).user_id).toBe('user-99');
  });

  test('awaits an async resolveUserId', async () => {
    const ff = fakeFetch(202);
    const handler = createIngestRelay({
      endpoint: ENDPOINT,
      trustedIngestToken: TOKEN,
      resolveUserId: async () => 'async-user',
      fetch: ff.fn,
    });
    const res = await handler(relayReq(sampleBatch()));
    expect(res.status).toBe(204);
    expect(evt(0, nth(ff, 0)).user_id).toBe('async-user');
  });

  test('unauthenticated (resolveUserId null) forwards anonymously and returns 204', async () => {
    const ff = fakeFetch(202);
    const handler = createIngestRelay({
      endpoint: ENDPOINT,
      trustedIngestToken: TOKEN,
      resolveUserId: () => null,
      fetch: ff.fn,
    });
    const res = await handler(relayReq(sampleBatch()));
    expect(res.status).toBe(204);
    expect(evt(0, nth(ff, 0)).user_id).toBeUndefined();
  });

  test('upstream 400 -> 400; upstream 403 and 5xx and network -> 502', async () => {
    const make = (status: number, throwIt = false) => {
      const ff = fakeFetch(status);
      if (throwIt) ff.throwNext();
      const handler = createIngestRelay({
        endpoint: ENDPOINT,
        trustedIngestToken: TOKEN,
        resolveUserId: () => 'u',
        fetch: ff.fn,
      });
      return handler(relayReq(sampleBatch()));
    };
    expect((await make(400)).status).toBe(400);
    expect((await make(403)).status).toBe(502);
    expect((await make(500)).status).toBe(502);
    expect((await make(202, true)).status).toBe(502);
  });

  test('a throwing resolveUserId -> 500, no forward, and its error never reaches the caller', async () => {
    const ff = fakeFetch(202);
    const handler = createIngestRelay({
      endpoint: ENDPOINT,
      trustedIngestToken: TOKEN,
      resolveUserId: () => {
        throw new Error('db connection postgres://secret@host failed');
      },
      fetch: ff.fn,
    });
    const res = await handler(relayReq(sampleBatch()));
    expect(res.status).toBe(500);
    expect(await res.text()).toBe(''); // host internals never sent back
    expect(ff.calls).toHaveLength(0);
  });

  test('malformed JSON body -> 400, no forward', async () => {
    const ff = fakeFetch(202);
    const handler = createIngestRelay({
      endpoint: ENDPOINT,
      trustedIngestToken: TOKEN,
      resolveUserId: () => 'u',
      fetch: ff.fn,
    });
    const res = await handler(relayReq('{ not json'));
    expect(res.status).toBe(400);
    expect(ff.calls).toHaveLength(0);
  });

  test('body without an events array -> 400, no forward', async () => {
    const ff = fakeFetch(202);
    const handler = createIngestRelay({
      endpoint: ENDPOINT,
      trustedIngestToken: TOKEN,
      resolveUserId: () => 'u',
      fetch: ff.fn,
    });
    const res = await handler(relayReq({ product_id: 'clipcast' }));
    expect(res.status).toBe(400);
    expect(ff.calls).toHaveLength(0);
  });
});
