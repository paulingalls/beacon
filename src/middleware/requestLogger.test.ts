import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { Hono } from 'hono';

import type { EventBuffer } from '../events/buffer';
import type { BeaconEvent } from '../types';
import { type RequestLoggerOptions, requestLogger } from './requestLogger';

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** A recording stand-in for EventBuffer — the middleware only calls push(). */
function recordingBuffer(): { buffer: EventBuffer; pushed: BeaconEvent[] } {
  const pushed: BeaconEvent[] = [];
  const buffer = { push: (e: BeaconEvent) => pushed.push(e) } as unknown as EventBuffer;
  return { buffer, pushed };
}

/** Hono app with the middleware mounted and a couple of test routes. */
function appWith(buffer: EventBuffer, opts: RequestLoggerOptions): Hono {
  const app = new Hono();
  app.use('*', requestLogger(buffer, opts));
  app.get('/hello', (c) => c.text('hello'));
  app.get('/healthz', (c) => c.text('ok'));
  return app;
}

describe('requestLogger', () => {
  test('skips paths matching an excludePaths prefix (no event, response intact)', async () => {
    const { buffer, pushed } = recordingBuffer();
    const app = appWith(buffer, { productId: 'p', excludePaths: ['/healthz'] });

    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    expect(pushed).toHaveLength(0);
  });

  test('captures a request event with HTTP details and transport context', async () => {
    const { buffer, pushed } = recordingBuffer();
    const app = appWith(buffer, { productId: 'clipcast' });

    const res = await app.request('/hello', {
      headers: {
        'user-agent': 'TestAgent/1.0',
        referer: 'https://ref.example',
        'accept-language': 'en-US,en;q=0.9',
      },
    });
    expect(res.status).toBe(200);

    expect(pushed).toHaveLength(1);
    const e = pushed[0] as BeaconEvent;
    expect(e.productId).toBe('clipcast');
    expect(e.eventType).toBe('request');
    expect(e.platform).toBe('web');
    expect(e.properties).toMatchObject({ path: '/hello', method: 'GET', status: 200 });
    expect(typeof (e.properties as { response_time_ms: number }).response_time_ms).toBe('number');
    expect(e.context).toMatchObject({
      user_agent: 'TestAgent/1.0',
      referrer: 'https://ref.example',
      accept_language: 'en-US', // first locale only
    });
  });

  test('hashes the client IP with SHA-256 (consistent), never storing the raw IP', async () => {
    const { buffer, pushed } = recordingBuffer();
    const app = appWith(buffer, { productId: 'p', hashIPs: true });
    const ip = '203.0.113.7';

    await app.request('/hello', { headers: { 'x-forwarded-for': `${ip}, 10.0.0.1` } });
    await app.request('/hello', { headers: { 'x-forwarded-for': ip } });

    const ips = pushed.map((e) => (e.context as { ip?: string }).ip);
    expect(ips[0]).toBe(sha256(ip)); // first XFF token, hashed
    expect(ips[1]).toBe(sha256(ip)); // consistent across requests
    expect(ips[0]).not.toContain(ip); // raw IP never stored
  });

  test('stores the raw IP when hashIPs is false', async () => {
    const { buffer, pushed } = recordingBuffer();
    const app = appWith(buffer, { productId: 'p', hashIPs: false });

    await app.request('/hello', { headers: { 'x-forwarded-for': '198.51.100.9' } });
    expect((pushed[0]?.context as { ip?: string }).ip).toBe('198.51.100.9');
  });

  test('a malformed X-App-Context header does not throw and platform stays web', async () => {
    const { buffer, pushed } = recordingBuffer();
    const app = appWith(buffer, { productId: 'p' });

    const res = await app.request('/hello', { headers: { 'x-app-context': '{not json' } });
    expect(res.status).toBe(200);
    expect(pushed[0]?.platform).toBe('web');
  });

  test('parses a valid X-App-Context and overrides platform', async () => {
    const { buffer, pushed } = recordingBuffer();
    const app = appWith(buffer, { productId: 'p' });

    const ctx = { platform: 'ios', appVersion: '1.2.3' };
    await app.request('/hello', { headers: { 'x-app-context': JSON.stringify(ctx) } });

    const e = pushed[0] as BeaconEvent;
    expect(e.platform).toBe('ios');
    expect((e.context as { app_context?: unknown }).app_context).toEqual(ctx);
  });

  test('ignores a non-object (array) X-App-Context, keeping platform web', async () => {
    const { buffer, pushed } = recordingBuffer();
    const app = appWith(buffer, { productId: 'p' });

    const res = await app.request('/hello', { headers: { 'x-app-context': '[1,2,3]' } });
    expect(res.status).toBe(200);
    expect(pushed[0]?.platform).toBe('web');
    expect((pushed[0]?.context as { app_context?: unknown }).app_context).toBeUndefined();
  });

  test('an empty-string platform falls back to web', async () => {
    const { buffer, pushed } = recordingBuffer();
    const app = appWith(buffer, { productId: 'p' });

    await app.request('/hello', { headers: { 'x-app-context': JSON.stringify({ platform: '' }) } });
    expect(pushed[0]?.platform).toBe('web');
  });

  test('logs a thrown handler as a request event with status 500', async () => {
    const { buffer, pushed } = recordingBuffer();
    const app = new Hono();
    app.use('*', requestLogger(buffer, { productId: 'p' }));
    app.get('/boom', () => {
      throw new Error('boom');
    });

    const res = await app.request('/boom');
    expect(res.status).toBe(500);
    // Hono's compose catches the throw and sets the 500 response before control
    // returns to the middleware, so the request is still logged with status 500.
    expect(pushed).toHaveLength(1);
    expect((pushed[0]?.properties as { status: number }).status).toBe(500);
  });

  test('logs the request when a downstream error propagates (onError rethrow), as status 500', async () => {
    const { buffer, pushed } = recordingBuffer();
    const app = new Hono();
    app.use('*', requestLogger(buffer, { productId: 'p' }));
    app.onError((err) => {
      // A host app whose onError rethrows lets the error propagate past the
      // middleware's `await next()`; the event must still be logged.
      throw err;
    });
    app.get('/boom', () => {
      throw new Error('boom');
    });

    await expect(app.request('/boom')).rejects.toThrow('boom');
    expect(pushed).toHaveLength(1);
    expect((pushed[0]?.properties as { status: number }).status).toBe(500);
  });

  test('a throwing getUserId never crashes the host response (failure isolation)', async () => {
    const { buffer, pushed } = recordingBuffer();
    const app = new Hono();
    app.use(
      '*',
      requestLogger(buffer, {
        productId: 'p',
        getUserId: () => {
          throw new Error('auth boom');
        },
      }),
    );
    app.get('/hello', (c) => c.text('hello'));

    const res = await app.request('/hello');
    expect(res.status).toBe(200); // host response unaffected
    expect(await res.text()).toBe('hello');
    expect(pushed).toHaveLength(0); // logging swallowed the failure, no event
  });

  test('a throwing getUserId does not mask a propagating handler error', async () => {
    const { buffer } = recordingBuffer();
    const app = new Hono();
    app.use(
      '*',
      requestLogger(buffer, {
        productId: 'p',
        getUserId: () => {
          throw new Error('auth boom');
        },
      }),
    );
    app.onError((err) => {
      throw err; // rethrow so the original handler error propagates
    });
    app.get('/boom', () => {
      throw new Error('handler boom');
    });

    // The ORIGINAL handler error must surface, not the getUserId error.
    await expect(app.request('/boom')).rejects.toThrow('handler boom');
  });

  test('uses getUserId for user_id, defaulting to null', async () => {
    const withUser = recordingBuffer();
    const appUser = appWith(withUser.buffer, { productId: 'p', getUserId: () => 'user-42' });
    await appUser.request('/hello');
    expect(withUser.pushed[0]?.userId).toBe('user-42');

    const noUser = recordingBuffer();
    const appAnon = appWith(noUser.buffer, { productId: 'p' });
    await appAnon.request('/hello');
    expect(noUser.pushed[0]?.userId).toBeNull();
  });
});
