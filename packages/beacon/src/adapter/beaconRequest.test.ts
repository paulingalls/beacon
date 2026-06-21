import { describe, expect, test } from 'bun:test';
import type { Context } from 'hono';

import { honoToBeaconRequest, requestToBeaconRequest } from './beaconRequest';

/**
 * Minimal Hono Context double exposing only what the adapter delegates to:
 * `c.req.{header,query,url,path,method,json}` and the `beaconVisitorToken`
 * variable bag (`get`/`set`). Mirrors the fake-Context patterns in
 * requestContext.test.ts / track.test.ts. clientAddress() is exercised
 * separately (getConnInfo throws off-server, so the default yields undefined).
 */
function honoCtx(
  opts: {
    headers?: Record<string, string>;
    query?: Record<string, string>;
    url?: string;
    path?: string;
    method?: string;
    body?: unknown;
    vars?: Record<string, unknown>;
  } = {},
): Context {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.headers ?? {})) lower[k.toLowerCase()] = v;
  const store: Record<string, unknown> = { ...(opts.vars ?? {}) };
  return {
    req: {
      header: (name: string) => lower[name.toLowerCase()],
      query: (name: string) => opts.query?.[name],
      url: opts.url ?? 'https://host.example/p?x=1',
      path: opts.path ?? '/p',
      method: opts.method ?? 'GET',
      json: async () => opts.body,
    },
    get: (key: string) => store[key],
    set: (key: string, value: unknown) => {
      store[key] = value;
    },
  } as unknown as Context;
}

describe('honoToBeaconRequest', () => {
  test('header/query/url/path/method reads match the Context', async () => {
    const req = honoToBeaconRequest(
      honoCtx({
        headers: { 'User-Agent': 'TestAgent/1.0', referer: 'https://ref.example' },
        query: { _t: 'v1', limit: '10' },
        url: 'https://host.example/landing?_t=v1',
        path: '/landing',
        method: 'POST',
        body: { events: [] },
      }),
    );

    // case-insensitive header lookup, undefined when absent
    expect(req.header('user-agent')).toBe('TestAgent/1.0');
    expect(req.header('Referer')).toBe('https://ref.example');
    expect(req.header('x-missing')).toBeUndefined();

    expect(req.query('_t')).toBe('v1');
    expect(req.query('limit')).toBe('10');
    expect(req.query('absent')).toBeUndefined();

    expect(req.url).toBe('https://host.example/landing?_t=v1');
    expect(req.path).toBe('/landing');
    expect(req.method).toBe('POST');
    expect(await req.json()).toEqual({ events: [] });
  });

  test('getToken/setToken proxy c.get/c.set("beaconVisitorToken")', () => {
    const c = honoCtx({ vars: { beaconVisitorToken: 'seeded' } });
    const req = honoToBeaconRequest(c);

    expect(req.getToken()).toBe('seeded');

    req.setToken('minted');
    expect(req.getToken()).toBe('minted');
    // write went through the underlying Context variable bag
    expect(c.get('beaconVisitorToken')).toBe('minted');
  });

  test('getToken returns null (not undefined) when no token is set', () => {
    const req = honoToBeaconRequest(honoCtx());
    expect(req.getToken()).toBeNull();
  });

  test('clientAddress is undefined when getConnInfo is unavailable (off-server)', () => {
    // The fake Context is not a real Bun socket, so getConnInfo throws and the
    // guarded default resolves to undefined — never throwing.
    const req = honoToBeaconRequest(honoCtx());
    expect(req.clientAddress()).toBeUndefined();
  });
});

describe('requestToBeaconRequest', () => {
  test('header/query/url/path/method/json read from a plain Web Request', async () => {
    const request = new Request('https://host.example/landing?x=1&_t=v1', {
      method: 'POST',
      headers: { 'User-Agent': 'PlainAgent/2.0', 'content-type': 'application/json' },
      body: JSON.stringify({ events: [{ event_type: 'tap' }] }),
    });
    const req = requestToBeaconRequest(request);

    expect(req.header('user-agent')).toBe('PlainAgent/2.0');
    expect(req.header('X-Missing')).toBeUndefined();

    expect(req.query('_t')).toBe('v1');
    expect(req.query('x')).toBe('1');
    expect(req.query('absent')).toBeUndefined();

    expect(req.url).toBe('https://host.example/landing?x=1&_t=v1');
    expect(req.path).toBe('/landing');
    expect(req.method).toBe('POST');
    expect(await req.json()).toEqual({ events: [{ event_type: 'tap' }] });
  });

  test('json() is memoized — a second call returns the same value, not "Body already read"', async () => {
    const request = new Request('https://host.example/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: [{ event_type: 'tap' }] }),
    });
    const req = requestToBeaconRequest(request);

    const first = await req.json();
    // A raw Request body is a one-shot stream; without memoization this throws.
    const second = await req.json();

    expect(first).toEqual({ events: [{ event_type: 'tap' }] });
    expect(second).toEqual(first);
  });

  test('clientAddress returns the injected socket address', () => {
    const req = requestToBeaconRequest(new Request('https://host.example/'), {
      clientAddress: '10.0.0.5',
    });
    expect(req.clientAddress()).toBe('10.0.0.5');
  });

  test('clientAddress is undefined when none is injected', () => {
    const req = requestToBeaconRequest(new Request('https://host.example/'));
    expect(req.clientAddress()).toBeUndefined();
  });

  test('token state threads through a closure (no Hono context bag)', () => {
    const req = requestToBeaconRequest(new Request('https://host.example/'));

    // no _t param, nothing set yet
    expect(req.getToken()).toBeNull();

    req.setToken('minted-in-closure');
    expect(req.getToken()).toBe('minted-in-closure');
  });
});
