import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import type { Context } from 'hono';

import type { EventSink } from '../events/sink';
import type { BeaconEvent } from '../types';
import { track } from './track';

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** A recording stand-in for the EventSink — track() only calls push(). */
function recordingBuffer(): { buffer: EventSink; pushed: BeaconEvent[] } {
  const pushed: BeaconEvent[] = [];
  const buffer: EventSink = { push: (e: BeaconEvent) => void pushed.push(e) };
  return { buffer, pushed };
}

/**
 * Minimal Context double: header reads + the get/set context bag track() uses
 * (it reads `beaconVisitorToken`). Headers are case-insensitive like Hono.
 */
function ctx(
  opts: { headers?: Record<string, string>; vars?: Record<string, unknown> } = {},
): Context {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.headers ?? {})) lower[k.toLowerCase()] = v;
  const store: Record<string, unknown> = { ...(opts.vars ?? {}) };
  return {
    req: { header: (name: string) => lower[name.toLowerCase()] },
    get: (key: string) => store[key],
    set: (key: string, value: unknown) => {
      store[key] = value;
    },
  } as unknown as Context;
}

describe('track', () => {
  test('pushes an event with type, properties, user_id, visitor_token, product_id', () => {
    const { buffer, pushed } = recordingBuffer();
    const c = ctx({
      headers: { 'user-agent': 'UA/1' },
      vars: { beaconVisitorToken: 'tok123456789' },
    });

    track(buffer, c, { productId: 'clipcast', getUserId: () => 'user-7' }, 'signup', {
      plan: 'pro',
    });

    expect(pushed).toHaveLength(1);
    const e = pushed[0] as BeaconEvent;
    expect(e.productId).toBe('clipcast');
    expect(e.eventType).toBe('signup');
    expect(e.properties).toEqual({ plan: 'pro' });
    expect(e.userId).toBe('user-7');
    expect(e.visitorToken).toBe('tok123456789');
    expect(e.context).toMatchObject({ user_agent: 'UA/1' });
    expect(e.timestamp).toBeInstanceOf(Date);
  });

  test('infers platform from X-App-Context, defaulting to web', () => {
    const withCtx = recordingBuffer();
    track(
      withCtx.buffer,
      ctx({ headers: { 'x-app-context': JSON.stringify({ platform: 'ios' }) } }),
      { productId: 'p' },
      'screen_view',
    );
    expect(withCtx.pushed[0]?.platform).toBe('ios');

    const noCtx = recordingBuffer();
    track(noCtx.buffer, ctx(), { productId: 'p' }, 'screen_view');
    expect(noCtx.pushed[0]?.platform).toBe('web');
  });

  test('defaults properties to an empty object when omitted', () => {
    const { buffer, pushed } = recordingBuffer();
    track(buffer, ctx(), { productId: 'p' }, 'evt');
    expect(pushed[0]?.properties).toEqual({});
  });

  test('reads visitor_token from context; null when absent', () => {
    const { buffer, pushed } = recordingBuffer();
    track(buffer, ctx(), { productId: 'p' }, 'evt');
    expect(pushed[0]?.visitorToken ?? null).toBeNull();
  });

  test('defaults user_id to null when no getUserId is configured', () => {
    const { buffer, pushed } = recordingBuffer();
    track(buffer, ctx(), { productId: 'p' }, 'evt');
    expect(pushed[0]?.userId ?? null).toBeNull();
  });

  test('throws on an empty or whitespace-only event type, pushing nothing', () => {
    const { buffer, pushed } = recordingBuffer();
    expect(() => track(buffer, ctx(), { productId: 'p' }, '')).toThrow();
    expect(() => track(buffer, ctx(), { productId: 'p' }, '   ')).toThrow();
    expect(pushed).toHaveLength(0);
  });

  test('throws on an event type longer than 100 chars; allows exactly 100', () => {
    const { buffer, pushed } = recordingBuffer();
    expect(() => track(buffer, ctx(), { productId: 'p' }, 'x'.repeat(101))).toThrow();
    expect(pushed).toHaveLength(0);

    track(buffer, ctx(), { productId: 'p' }, 'x'.repeat(100));
    expect(pushed).toHaveLength(1);
  });

  test('trims surrounding whitespace from event_type before storing', () => {
    const { buffer, pushed } = recordingBuffer();
    track(buffer, ctx(), { productId: 'p' }, '  signup  ');
    expect(pushed[0]?.eventType).toBe('signup');
  });

  test('returns void synchronously, having already pushed (fire-and-forget)', () => {
    const { buffer, pushed } = recordingBuffer();
    const result = track(buffer, ctx(), { productId: 'p' }, 'evt');
    expect(result).toBeUndefined();
    expect(pushed).toHaveLength(1); // pushed before track() returned — no await
  });

  test('swallows a throwing getUserId: user_id null, event still pushed (never crashes host)', () => {
    const { buffer, pushed } = recordingBuffer();
    track(
      buffer,
      ctx(),
      {
        productId: 'p',
        getUserId: () => {
          throw new Error('auth boom');
        },
      },
      'evt',
    );
    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.userId ?? null).toBeNull();
  });

  test('hashes the client IP by default; stores raw when hashIPs is false', () => {
    const ip = '203.0.113.7';

    const hashed = recordingBuffer();
    track(hashed.buffer, ctx({ headers: { 'x-forwarded-for': ip } }), { productId: 'p' }, 'evt');
    expect((hashed.pushed[0]?.context as { ip?: string }).ip).toBe(sha256(ip));

    const raw = recordingBuffer();
    track(
      raw.buffer,
      ctx({ headers: { 'x-forwarded-for': ip } }),
      { productId: 'p', hashIPs: false },
      'evt',
    );
    expect((raw.pushed[0]?.context as { ip?: string }).ip).toBe(ip);
  });

  test('resolves the socket address via injected getClientAddress when XFF is absent', () => {
    const { buffer, pushed } = recordingBuffer();
    track(
      buffer,
      ctx(),
      { productId: 'p', hashIPs: false, getClientAddress: () => '192.0.2.9' },
      'evt',
    );
    expect((pushed[0]?.context as { ip?: string }).ip).toBe('192.0.2.9');
  });
});
