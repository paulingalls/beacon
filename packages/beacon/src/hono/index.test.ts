import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import type { Context } from 'hono';

import {
  defaultClientAddress,
  honoRequest,
  honoToBeaconRequest,
  resolveEventFields,
  resolveIp,
} from './index';

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const noSocket = (): string | undefined => undefined;

/**
 * Minimal Hono Context double exposing what the adapter delegates to:
 * `c.req.{header,query,url,path,method,json}` and the `beaconVisitorToken`
 * variable bag (`get`/`set`). clientAddress() is exercised separately
 * (getConnInfo throws off-server, so the default yields undefined).
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

/** Minimal Context double exposing only `c.req.header(name)` (case-insensitive). */
function ctx(headers: Record<string, string> = {}): Context {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    req: { header: (name: string) => lower[name.toLowerCase()] },
  } as unknown as Context;
}

/** Context double exposing both `req.header` and `get('beaconVisitorToken')`. */
function eventCtx(opts: { headers?: Record<string, string>; visitorToken?: string } = {}): Context {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.headers ?? {})) lower[k.toLowerCase()] = v;
  return {
    req: { header: (name: string) => lower[name.toLowerCase()] },
    get: (key: string) => (key === 'beaconVisitorToken' ? opts.visitorToken : undefined),
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

describe('honoRequest', () => {
  test('without an override, clientAddress comes from the adapter (undefined off-server)', () => {
    expect(honoRequest(ctx()).clientAddress()).toBeUndefined();
  });

  test('with an override, clientAddress returns the injected value', () => {
    expect(honoRequest(ctx(), () => '10.0.0.9').clientAddress()).toBe('10.0.0.9');
  });

  test('swallows a throwing override (§1.3), yielding undefined', () => {
    const throwing = (): string => {
      throw new Error('host override boom');
    };
    expect(honoRequest(ctx(), throwing).clientAddress()).toBeUndefined();
  });

  test('reads headers from the underlying Context', () => {
    expect(honoRequest(ctx({ 'user-agent': 'UA/2' })).header('user-agent')).toBe('UA/2');
  });
});

describe('resolveIp', () => {
  test('uses the first X-Forwarded-For token, SHA-256 hashed when enabled', () => {
    const c = ctx({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' });
    expect(resolveIp(c, true, noSocket)).toBe(sha256('203.0.113.7'));
  });

  test('returns the raw first XFF token when hashIPs is false', () => {
    const c = ctx({ 'x-forwarded-for': '198.51.100.9, 10.0.0.1' });
    expect(resolveIp(c, false, noSocket)).toBe('198.51.100.9');
  });

  test('trims surrounding whitespace on the XFF token', () => {
    const c = ctx({ 'x-forwarded-for': '  203.0.113.7 , 10.0.0.1' });
    expect(resolveIp(c, false, noSocket)).toBe('203.0.113.7');
  });

  test('falls back to the socket address when X-Forwarded-For is absent', () => {
    const c = ctx();
    expect(resolveIp(c, false, () => '192.0.2.55')).toBe('192.0.2.55');
  });

  test('hashes the socket-derived address when hashIPs is on', () => {
    const c = ctx();
    expect(resolveIp(c, true, () => '192.0.2.55')).toBe(sha256('192.0.2.55'));
  });

  test('X-Forwarded-For takes precedence over the socket address', () => {
    const c = ctx({ 'x-forwarded-for': '203.0.113.7' });
    expect(resolveIp(c, false, () => 'socket-addr')).toBe('203.0.113.7');
  });

  test('is undefined when neither XFF nor a socket address is available', () => {
    expect(resolveIp(ctx(), true, noSocket)).toBeUndefined();
  });

  test('never stores the raw IP once hashed', () => {
    const ip = '203.0.113.7';
    const out = resolveIp(ctx({ 'x-forwarded-for': ip }), true, noSocket);
    expect(out).not.toContain(ip);
  });

  test('swallows a throwing custom getClientAddress and falls back to XFF (§1.3)', () => {
    const throwing = () => {
      throw new Error('host override boom');
    };
    const c = ctx({ 'x-forwarded-for': '203.0.113.7' });
    expect(resolveIp(c, false, throwing)).toBe('203.0.113.7');
  });

  test('returns undefined (does not crash) when getClientAddress throws and no XFF', () => {
    const throwing = () => {
      throw new Error('host override boom');
    };
    expect(resolveIp(ctx(), false, throwing)).toBeUndefined();
  });
});

describe('defaultClientAddress', () => {
  test('returns undefined rather than throwing when no real socket exists', () => {
    // getConnInfo throws off a live Bun server; the resolver must swallow it.
    expect(defaultClientAddress(ctx())).toBeUndefined();
  });
});

describe('resolveEventFields', () => {
  test('resolves user id, visitor token, ip, platform, and context together', () => {
    const c = eventCtx({
      headers: { 'x-forwarded-for': '203.0.113.7', 'user-agent': 'UA/1' },
      visitorToken: 'tok-123',
    });
    const fields = resolveEventFields(c, {
      getUserId: () => 'user-9',
      hashIPs: false,
      getClientAddress: noSocket,
      label: 'track',
    });
    expect(fields.userId).toBe('user-9');
    expect(fields.visitorToken).toBe('tok-123');
    expect(fields.ip).toBe('203.0.113.7');
    expect(fields.platform).toBe('web');
    expect((fields.context as { user_agent?: string }).user_agent).toBe('UA/1');
    expect((fields.context as { ip?: string }).ip).toBe('203.0.113.7'); // same ip threaded into context
  });

  test('hashes the ip when hashIPs defaults on', () => {
    const c = eventCtx({ headers: { 'x-forwarded-for': '203.0.113.7' } });
    const fields = resolveEventFields(c, { getClientAddress: noSocket, label: 'redirect' });
    expect(fields.ip).toBe(sha256('203.0.113.7'));
    expect((fields.context as { ip?: string }).ip).toBe(sha256('203.0.113.7'));
  });

  test('a throwing getUserId is failure-isolated to a null user id (§1.3); other fields still resolve', () => {
    const c = eventCtx({ headers: { 'x-forwarded-for': '1.2.3.4' }, visitorToken: 'tok' });
    const fields = resolveEventFields(c, {
      getUserId: () => {
        throw new Error('auth boom');
      },
      hashIPs: false,
      getClientAddress: noSocket,
      label: 'ingest',
    });
    expect(fields.userId).toBeNull();
    expect(fields.visitorToken).toBe('tok');
    expect(fields.ip).toBe('1.2.3.4');
  });

  test('null user id and null visitor token when neither is present', () => {
    const fields = resolveEventFields(eventCtx(), { getClientAddress: noSocket, label: 'track' });
    expect(fields.userId).toBeNull();
    expect(fields.visitorToken).toBeNull();
    expect(fields.ip).toBeUndefined();
    expect(fields.platform).toBe('web');
  });

  test('derives platform from the X-App-Context header', () => {
    const c = eventCtx({ headers: { 'x-app-context': JSON.stringify({ platform: 'ios' }) } });
    const fields = resolveEventFields(c, { getClientAddress: noSocket, label: 'track' });
    expect(fields.platform).toBe('ios');
  });
});
