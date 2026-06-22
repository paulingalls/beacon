import { describe, expect, test } from 'bun:test';

import { createIdentifyRelay, relayIdentify } from './identifyRelay';

const ENDPOINT = 'https://beacon.example/analytics/identify';
const TOKEN = 'super-secret-trusted-token';

/** A fetch double that records calls and returns a scriptable Response. */
function fakeFetch(status = 204) {
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

function nth(ff: { calls: { url: string; init: RequestInit }[] }, i: number) {
  const c = ff.calls[i];
  if (!c) throw new Error(`no fetch call at index ${i}`);
  return c;
}
function bodyOf(call: { init: RequestInit }): Record<string, unknown> {
  return JSON.parse(call.init.body as string);
}
function headersOf(call: { init: RequestInit }): Record<string, string> {
  return call.init.headers as Record<string, string>;
}

describe('relayIdentify — primitive', () => {
  test('POSTs {visitor_token, user_id} to the endpoint under the bearer', async () => {
    const ff = fakeFetch(204);
    const r = await relayIdentify(
      { visitorToken: 'device-handle', userId: 'user-42' },
      { endpoint: ENDPOINT, trustedIngestToken: TOKEN, fetch: ff.fn },
    );

    expect(r).toEqual({ outcome: 'ok', status: 204 });
    expect(nth(ff, 0).url).toBe(ENDPOINT);
    expect(nth(ff, 0).init.method).toBe('POST');
    expect(headersOf(nth(ff, 0)).authorization).toBe(`Bearer ${TOKEN}`);
    expect(headersOf(nth(ff, 0))['content-type']).toBe('application/json');
    expect(bodyOf(nth(ff, 0))).toEqual({ visitor_token: 'device-handle', user_id: 'user-42' });
  });

  test('outcome mapping: 400 -> caller_error, 403 -> retryable, network -> retryable(0)', async () => {
    const e400 = await relayIdentify(
      { visitorToken: 'v', userId: 'u' },
      { endpoint: ENDPOINT, trustedIngestToken: TOKEN, fetch: fakeFetch(400).fn },
    );
    expect(e400).toEqual({ outcome: 'caller_error', status: 400 });

    const e403 = await relayIdentify(
      { visitorToken: 'v', userId: 'u' },
      { endpoint: ENDPOINT, trustedIngestToken: TOKEN, fetch: fakeFetch(403).fn },
    );
    expect(e403).toEqual({ outcome: 'retryable', status: 403 });

    const ffNet = fakeFetch();
    ffNet.throwNext();
    const eNet = await relayIdentify(
      { visitorToken: 'v', userId: 'u' },
      { endpoint: ENDPOINT, trustedIngestToken: TOKEN, fetch: ffNet.fn },
    );
    expect(eNet).toEqual({ outcome: 'retryable', status: 0 });
  });

  test('fails closed when the token is empty: throws, no forward', async () => {
    const ff = fakeFetch();
    let thrown: unknown;
    try {
      await relayIdentify(
        { visitorToken: 'v', userId: 'u' },
        { endpoint: ENDPOINT, trustedIngestToken: '', fetch: ff.fn },
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(ff.calls).toHaveLength(0);
  });
});

describe('createIdentifyRelay — Request -> Response handler', () => {
  function loginReq(body: unknown): Request {
    return new Request('https://app.example/beacon/identify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  }

  test('throws at construction when the trusted token is empty', () => {
    expect(() =>
      createIdentifyRelay({ endpoint: ENDPOINT, trustedIngestToken: '', resolveUserId: () => 'u' }),
    ).toThrow();
  });

  test('passes the Request to resolveUserId, relays {visitor_token, user_id}, returns 204', async () => {
    const ff = fakeFetch(204);
    let seen: Request | undefined;
    const handler = createIdentifyRelay({
      endpoint: ENDPOINT,
      trustedIngestToken: TOKEN,
      resolveUserId: (req) => {
        seen = req;
        return 'user-99';
      },
      fetch: ff.fn,
    });

    const res = await handler(loginReq({ visitor_token: 'device-handle' }));
    expect(res.status).toBe(204);
    expect(seen).toBeInstanceOf(Request);
    expect(bodyOf(nth(ff, 0))).toEqual({ visitor_token: 'device-handle', user_id: 'user-99' });
  });

  test('awaits an async resolveUserId', async () => {
    const ff = fakeFetch(204);
    const handler = createIdentifyRelay({
      endpoint: ENDPOINT,
      trustedIngestToken: TOKEN,
      resolveUserId: async () => 'async-user',
      fetch: ff.fn,
    });
    const res = await handler(loginReq({ visitor_token: 'device-handle' }));
    expect(res.status).toBe(204);
    expect(bodyOf(nth(ff, 0)).user_id).toBe('async-user');
  });

  test('missing/empty visitor_token -> 400, no forward', async () => {
    const ff = fakeFetch(204);
    const handler = createIdentifyRelay({
      endpoint: ENDPOINT,
      trustedIngestToken: TOKEN,
      resolveUserId: () => 'u',
      fetch: ff.fn,
    });
    expect((await handler(loginReq({}))).status).toBe(400);
    expect((await handler(loginReq({ visitor_token: '' }))).status).toBe(400);
    expect((await handler(loginReq({ visitor_token: 123 }))).status).toBe(400);
    expect(ff.calls).toHaveLength(0);
  });

  test('forwards the trimmed visitor_token (validator/forwarder symmetry)', async () => {
    const ff = fakeFetch(204);
    const handler = createIdentifyRelay({
      endpoint: ENDPOINT,
      trustedIngestToken: TOKEN,
      resolveUserId: () => 'u',
      fetch: ff.fn,
    });
    const res = await handler(loginReq({ visitor_token: '  device-handle  ' }));
    expect(res.status).toBe(204);
    expect(bodyOf(nth(ff, 0)).visitor_token).toBe('device-handle');
  });

  test('whitespace-only visitor_token -> 400, no forward', async () => {
    const ff = fakeFetch(204);
    const handler = createIdentifyRelay({
      endpoint: ENDPOINT,
      trustedIngestToken: TOKEN,
      resolveUserId: () => 'u',
      fetch: ff.fn,
    });
    expect((await handler(loginReq({ visitor_token: '   ' }))).status).toBe(400);
    expect(ff.calls).toHaveLength(0);
  });

  test('null/empty resolved user -> 400, no forward (identify needs a user)', async () => {
    const ff = fakeFetch(204);
    const handlerNull = createIdentifyRelay({
      endpoint: ENDPOINT,
      trustedIngestToken: TOKEN,
      resolveUserId: () => null,
      fetch: ff.fn,
    });
    expect((await handlerNull(loginReq({ visitor_token: 'v' }))).status).toBe(400);

    const handlerEmpty = createIdentifyRelay({
      endpoint: ENDPOINT,
      trustedIngestToken: TOKEN,
      resolveUserId: () => '',
      fetch: ff.fn,
    });
    expect((await handlerEmpty(loginReq({ visitor_token: 'v' }))).status).toBe(400);
    expect(ff.calls).toHaveLength(0);
  });

  test('a throwing resolveUserId -> 500, no forward, and its error never reaches the caller', async () => {
    const ff = fakeFetch(204);
    const handler = createIdentifyRelay({
      endpoint: ENDPOINT,
      trustedIngestToken: TOKEN,
      resolveUserId: () => {
        throw new Error('db connection postgres://secret@host failed');
      },
      fetch: ff.fn,
    });
    const res = await handler(loginReq({ visitor_token: 'v' }));
    expect(res.status).toBe(500);
    expect(await res.text()).toBe(''); // host internals never sent back
    expect(ff.calls).toHaveLength(0);
  });

  test('malformed JSON body -> 400, no forward', async () => {
    const ff = fakeFetch(204);
    const handler = createIdentifyRelay({
      endpoint: ENDPOINT,
      trustedIngestToken: TOKEN,
      resolveUserId: () => 'u',
      fetch: ff.fn,
    });
    expect((await handler(loginReq('{ not json'))).status).toBe(400);
    expect(ff.calls).toHaveLength(0);
  });

  test('upstream 400 -> 400; upstream 403/5xx/network -> 502', async () => {
    const make = (status: number, throwIt = false) => {
      const ff = fakeFetch(status);
      if (throwIt) ff.throwNext();
      const handler = createIdentifyRelay({
        endpoint: ENDPOINT,
        trustedIngestToken: TOKEN,
        resolveUserId: () => 'u',
        fetch: ff.fn,
      });
      return handler(loginReq({ visitor_token: 'v' }));
    };
    expect((await make(400)).status).toBe(400);
    expect((await make(403)).status).toBe(502);
    expect((await make(500)).status).toBe(502);
    expect((await make(204, true)).status).toBe(502);
  });
});
