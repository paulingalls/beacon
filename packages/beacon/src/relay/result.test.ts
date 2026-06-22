import { describe, expect, test } from 'bun:test';

import { classify, forwardJson, resultToResponse } from './result';

const ENDPOINT = 'https://beacon.example/analytics/events';
const TOKEN = 'super-secret-trusted-token';

/** A fetch double that records calls and returns a scriptable Response. */
function fakeFetch(status = 202) {
  const calls: { url: string; init: RequestInit }[] = [];
  const nextStatus = status;
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

describe('classify — only upstream 400 is non-retryable', () => {
  test('2xx -> ok', () => {
    expect(classify(202)).toEqual({ outcome: 'ok', status: 202 });
    expect(classify(204)).toEqual({ outcome: 'ok', status: 204 });
    expect(classify(200)).toEqual({ outcome: 'ok', status: 200 });
  });

  test('400 -> caller_error (device-fault, unfixable by retry)', () => {
    expect(classify(400)).toEqual({ outcome: 'caller_error', status: 400 });
  });

  test('every other non-2xx -> retryable (never drop valid work)', () => {
    for (const status of [301, 401, 403, 404, 429, 500, 502, 503]) {
      expect(classify(status)).toEqual({ outcome: 'retryable', status });
    }
  });
});

describe('resultToResponse — outcome -> device-actionable status', () => {
  test('ok -> 204', () => {
    expect(resultToResponse({ outcome: 'ok', status: 202 }).status).toBe(204);
  });
  test('caller_error -> 400', () => {
    expect(resultToResponse({ outcome: 'caller_error', status: 400 }).status).toBe(400);
  });
  test('retryable -> 502', () => {
    expect(resultToResponse({ outcome: 'retryable', status: 503 }).status).toBe(502);
  });
});

describe('forwardJson — the single trusted-POST seam', () => {
  test('POSTs the JSON body to the endpoint with Bearer auth + content-type', async () => {
    const ff = fakeFetch(202);
    await forwardJson(ENDPOINT, TOKEN, { product_id: 'clipcast', events: [] }, ff.fn, 'relayBatch');

    expect(ff.calls).toHaveLength(1);
    expect(nth(ff, 0).url).toBe(ENDPOINT);
    const init = nth(ff, 0).init;
    expect(init.method).toBe('POST');
    const h = init.headers as Record<string, string>;
    expect(h.authorization).toBe(`Bearer ${TOKEN}`);
    expect(h['content-type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ product_id: 'clipcast', events: [] });
  });

  test('returns the classified outcome for the upstream status', async () => {
    expect(await forwardJson(ENDPOINT, TOKEN, {}, fakeFetch(202).fn)).toEqual({
      outcome: 'ok',
      status: 202,
    });
    expect(await forwardJson(ENDPOINT, TOKEN, {}, fakeFetch(400).fn)).toEqual({
      outcome: 'caller_error',
      status: 400,
    });
    expect(await forwardJson(ENDPOINT, TOKEN, {}, fakeFetch(403).fn)).toEqual({
      outcome: 'retryable',
      status: 403,
    });
    expect(await forwardJson(ENDPOINT, TOKEN, {}, fakeFetch(500).fn)).toEqual({
      outcome: 'retryable',
      status: 500,
    });
  });

  test('network error -> retryable with status 0', async () => {
    const ff = fakeFetch();
    ff.throwNext();
    expect(await forwardJson(ENDPOINT, TOKEN, {}, ff.fn)).toEqual({
      outcome: 'retryable',
      status: 0,
    });
  });

  test('fails closed when the token is empty: throws, does not forward, no token in message', async () => {
    const ff = fakeFetch();
    let thrown: unknown;
    try {
      await forwardJson(ENDPOINT, '', { events: [] }, ff.fn);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(ff.calls).toHaveLength(0);
  });
});
