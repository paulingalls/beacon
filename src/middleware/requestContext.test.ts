import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import type { Context } from 'hono';

import {
  buildEventContext,
  defaultClientAddress,
  firstLocale,
  parseAppContext,
  resolveIp,
} from './requestContext';

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/**
 * Minimal Context double exposing only `c.req.header(name)` (case-insensitive,
 * undefined when absent — matching Hono). The requestContext helpers read
 * headers and nothing else, so this is all they need.
 */
function ctx(headers: Record<string, string> = {}): Context {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    req: { header: (name: string) => lower[name.toLowerCase()] },
  } as unknown as Context;
}

const noSocket = (): string | undefined => undefined;

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
});

describe('defaultClientAddress', () => {
  test('returns undefined rather than throwing when no real socket exists', () => {
    // getConnInfo throws off a live Bun server; the resolver must swallow it.
    expect(defaultClientAddress(ctx())).toBeUndefined();
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
    const c = ctx({
      'user-agent': 'TestAgent/1.0',
      referer: 'https://ref.example',
      'accept-language': 'en-US,en;q=0.9',
    });
    const { context } = buildEventContext(c, 'hashed-ip');
    expect(context).toEqual({
      user_agent: 'TestAgent/1.0',
      referrer: 'https://ref.example',
      accept_language: 'en-US', // first locale only
      ip: 'hashed-ip',
    });
  });

  test('passes the ip through unchanged, including undefined', () => {
    const { context } = buildEventContext(ctx(), undefined);
    expect((context as { ip?: string }).ip).toBeUndefined();
  });

  test('defaults platform to web with no app-context header', () => {
    expect(buildEventContext(ctx(), undefined).platform).toBe('web');
  });

  test('derives platform from a valid X-App-Context and attaches app_context', () => {
    const appContext = { platform: 'ios', appVersion: '1.2.3' };
    const c = ctx({ 'x-app-context': JSON.stringify(appContext) });
    const { context, platform } = buildEventContext(c, undefined);
    expect(platform).toBe('ios');
    expect((context as { app_context?: unknown }).app_context).toEqual(appContext);
  });

  test('falls back to web when the declared platform is an empty string', () => {
    const c = ctx({ 'x-app-context': JSON.stringify({ platform: '' }) });
    expect(buildEventContext(c, undefined).platform).toBe('web');
  });

  test('ignores a non-object app-context, keeping platform web and no app_context', () => {
    const c = ctx({ 'x-app-context': '[1,2,3]' });
    const { context, platform } = buildEventContext(c, undefined);
    expect(platform).toBe('web');
    expect((context as { app_context?: unknown }).app_context).toBeUndefined();
  });
});
