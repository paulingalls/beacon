import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import type { BeaconRequest } from '../adapter/beaconRequest';
import {
  buildEventContext,
  firstLocale,
  hashIp,
  parseAppContext,
  resolveEventFieldsFromRequest,
  resolveIpFromRequest,
} from './requestContext';

// The Hono-Context shims (honoRequest/resolveEventFields/resolveIp/defaultClientAddress)
// moved to ../hono (the ./hono subpath); their coverage lives in ../hono/index.test.ts.
// This file covers only the framework-agnostic cores that read off a BeaconRequest.

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/**
 * Minimal BeaconRequest double for the framework-agnostic cores (resolveIpFromRequest,
 * buildEventContext, resolveEventFieldsFromRequest) — exposes case-insensitive
 * header(), an injectable clientAddress(), and a visitor-token get/set.
 */
function beaconReq(
  opts: {
    headers?: Record<string, string>;
    query?: Record<string, string>;
    clientAddress?: string;
    token?: string | null;
  } = {},
): BeaconRequest {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.headers ?? {})) lower[k.toLowerCase()] = v;
  let token: string | null = opts.token ?? null;
  return {
    header: (name) => lower[name.toLowerCase()],
    query: (name) => opts.query?.[name],
    url: 'https://host.example/p',
    path: '/p',
    method: 'GET',
    json: async () => undefined,
    clientAddress: () => opts.clientAddress,
    getToken: () => token,
    setToken: (v) => {
      token = v;
    },
  };
}

describe('resolveIpFromRequest', () => {
  test('uses the first X-Forwarded-For token, SHA-256 hashed when enabled', () => {
    const req = beaconReq({ headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' } });
    expect(resolveIpFromRequest(req, true)).toBe(sha256('203.0.113.7'));
  });

  test('falls back to clientAddress() when X-Forwarded-For is absent', () => {
    expect(resolveIpFromRequest(beaconReq({ clientAddress: '192.0.2.55' }), false)).toBe(
      '192.0.2.55',
    );
  });

  test('X-Forwarded-For takes precedence over clientAddress()', () => {
    const req = beaconReq({
      headers: { 'x-forwarded-for': '203.0.113.7' },
      clientAddress: 'socket-addr',
    });
    expect(resolveIpFromRequest(req, false)).toBe('203.0.113.7');
  });

  test('is undefined when neither XFF nor a socket address is available', () => {
    expect(resolveIpFromRequest(beaconReq(), true)).toBeUndefined();
  });
});

describe('hashIp', () => {
  test('SHA-256 hashes the ip when hashIPs is on', () => {
    expect(hashIp('203.0.113.7', true)).toBe(sha256('203.0.113.7'));
  });

  test('passes the ip through unchanged when hashIPs is off', () => {
    expect(hashIp('203.0.113.7', false)).toBe('203.0.113.7');
  });

  test('returns undefined for an undefined ip regardless of hashIPs', () => {
    expect(hashIp(undefined, true)).toBeUndefined();
    expect(hashIp(undefined, false)).toBeUndefined();
  });

  test('never returns the raw ip once hashed', () => {
    const ip = '203.0.113.7';
    expect(hashIp(ip, true)).not.toContain(ip);
  });
});

describe('parseAppContext', () => {
  test('parses a valid JSON object', () => {
    const obj = { platform: 'ios', appVersion: '1.2.3' };
    expect(parseAppContext(JSON.stringify(obj))).toEqual(obj);
  });

  test('returns undefined for malformed JSON', () => {
    expect(parseAppContext('{not json')).toBeUndefined();
  });

  test('returns undefined for a JSON array', () => {
    expect(parseAppContext('[1,2,3]')).toBeUndefined();
  });

  test('returns undefined for a JSON primitive', () => {
    expect(parseAppContext('42')).toBeUndefined();
    expect(parseAppContext('"hi"')).toBeUndefined();
  });

  test('returns undefined for an absent header', () => {
    expect(parseAppContext(undefined)).toBeUndefined();
  });
});

describe('firstLocale', () => {
  test('returns the first locale only', () => {
    expect(firstLocale('en-US,en;q=0.9')).toBe('en-US');
  });

  test('trims whitespace around the first token', () => {
    expect(firstLocale('  fr-CA , fr')).toBe('fr-CA');
  });

  test('returns undefined for absent or empty values', () => {
    expect(firstLocale(undefined)).toBeUndefined();
    expect(firstLocale('')).toBeUndefined();
    expect(firstLocale('   ')).toBeUndefined();
  });
});

describe('buildEventContext', () => {
  test('assembles transport context from headers and the passed-in ip', () => {
    const req = beaconReq({
      headers: {
        'user-agent': 'TestAgent/1.0',
        referer: 'https://ref.example',
        'accept-language': 'en-US,en;q=0.9',
      },
    });
    const { context } = buildEventContext(req, 'hashed-ip');
    expect(context).toEqual({
      user_agent: 'TestAgent/1.0',
      referrer: 'https://ref.example',
      accept_language: 'en-US', // first locale only
      ip: 'hashed-ip',
    });
  });

  test('passes the ip through unchanged, including undefined', () => {
    const { context } = buildEventContext(beaconReq(), undefined);
    expect((context as { ip?: string }).ip).toBeUndefined();
  });

  test('defaults platform to web with no app-context header', () => {
    expect(buildEventContext(beaconReq(), undefined).platform).toBe('web');
  });

  test('derives platform from a valid X-App-Context and attaches app_context', () => {
    const appContext = { platform: 'ios', appVersion: '1.2.3' };
    const req = beaconReq({ headers: { 'x-app-context': JSON.stringify(appContext) } });
    const { context, platform } = buildEventContext(req, undefined);
    expect(platform).toBe('ios');
    expect((context as { app_context?: unknown }).app_context).toEqual(appContext);
  });

  test('falls back to web when the declared platform is an empty string', () => {
    const req = beaconReq({ headers: { 'x-app-context': JSON.stringify({ platform: '' }) } });
    expect(buildEventContext(req, undefined).platform).toBe('web');
  });

  test('ignores a non-object app-context, keeping platform web and no app_context', () => {
    const req = beaconReq({ headers: { 'x-app-context': '[1,2,3]' } });
    const { context, platform } = buildEventContext(req, undefined);
    expect(platform).toBe('web');
    expect((context as { app_context?: unknown }).app_context).toBeUndefined();
  });
});

describe('resolveEventFieldsFromRequest', () => {
  test('assembles fields from the request with the caller-resolved userId', () => {
    const req = beaconReq({
      headers: { 'x-forwarded-for': '203.0.113.7', 'user-agent': 'UA/1' },
      token: 'tok-123',
    });
    const fields = resolveEventFieldsFromRequest(req, { userId: 'user-9', hashIPs: false });
    expect(fields.userId).toBe('user-9');
    expect(fields.visitorToken).toBe('tok-123');
    expect(fields.ip).toBe('203.0.113.7');
    expect(fields.platform).toBe('web');
    expect((fields.context as { user_agent?: string }).user_agent).toBe('UA/1');
    expect((fields.context as { ip?: string }).ip).toBe('203.0.113.7'); // same ip threaded into context
  });

  test('hashes the ip when hashIPs defaults on; null userId/token pass through', () => {
    const fields = resolveEventFieldsFromRequest(
      beaconReq({ headers: { 'x-forwarded-for': '203.0.113.7' } }),
      { userId: null },
    );
    expect(fields.userId).toBeNull();
    expect(fields.visitorToken).toBeNull();
    expect(fields.ip).toBe(sha256('203.0.113.7'));
    expect((fields.context as { ip?: string }).ip).toBe(sha256('203.0.113.7'));
  });

  test('reads the visitor token from the request (getToken)', () => {
    const fields = resolveEventFieldsFromRequest(beaconReq({ token: 'tok-xyz' }), { userId: null });
    expect(fields.visitorToken).toBe('tok-xyz');
  });
});
