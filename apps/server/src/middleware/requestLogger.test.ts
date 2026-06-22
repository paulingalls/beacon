import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { BeaconEvent } from '@pi-innovations/beacon-sdk';
import { Hono } from 'hono';
import type { EventBuffer } from '../events/buffer';
import { VisitorTokenStore } from '../visitors/tokenStore';
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

// Real VisitorTokenStores, tracked so each one's sweep timer is cleared.
const openStores: VisitorTokenStore[] = [];
function makeStore(): VisitorTokenStore {
  const store = new VisitorTokenStore();
  openStores.push(store);
  return store;
}
afterEach(() => {
  while (openStores.length) openStores.pop()?.stop();
});

/** App that echoes the context visitor token from inside the handler. */
function tokenApp(buffer: EventBuffer, opts: RequestLoggerOptions): Hono {
  const app = new Hono();
  app.use('*', requestLogger(buffer, opts));
  app.get('/whoami', (c) => c.text(c.get('beaconVisitorToken') ?? 'none'));
  app.get('/landing', (c) => c.text('hi'));
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

  test('logs the onError-supplied status when a custom onError handles the throw', async () => {
    const { buffer, pushed } = recordingBuffer();
    const app = new Hono();
    app.use('*', requestLogger(buffer, { productId: 'p' }));
    app.onError((_err, c) => {
      // A non-rethrowing onError produces a real response; Hono leaves c.error
      // set but writes this response into c.res, so its status is the truth.
      return c.json({ error: 'unauthorized' }, 401);
    });
    app.get('/boom', () => {
      throw new Error('boom');
    });

    const res = await app.request('/boom');
    expect(res.status).toBe(401);
    expect(pushed).toHaveLength(1);
    expect((pushed[0]?.properties as { status: number }).status).toBe(401);
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

describe('requestLogger — visitor tokens', () => {
  test('authenticated request skips token logic — no token minted or exposed', async () => {
    const store = makeStore();
    const { buffer, pushed } = recordingBuffer();
    const app = tokenApp(buffer, { productId: 'p', getUserId: () => 'user-1', tokenStore: store });

    const res = await app.request('/whoami');
    expect(await res.text()).toBe('none'); // no context token during the handler
    expect(store.stats().active).toBe(0); // nothing minted
    expect(pushed[0]?.userId).toBe('user-1');
    expect(pushed[0]?.visitorToken ?? null).toBeNull();
  });

  test('anonymous request without _t mints a token, readable in-handler and on the event', async () => {
    const store = makeStore();
    const { buffer, pushed } = recordingBuffer();
    const app = tokenApp(buffer, { productId: 'p', tokenStore: store });

    // The handler echoes c.get('beaconVisitorToken') — proves the token is
    // resolved BEFORE next() runs (host can use it to build ?_t= links).
    const res = await app.request('/whoami');
    const tokenInHandler = await res.text();
    expect(tokenInHandler).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(pushed[0]?.visitorToken).toBe(tokenInHandler);
    expect(store.get(tokenInHandler)).not.toBeNull();
  });

  test('a valid _t reuses the existing token (touch, no new mint)', async () => {
    const store = makeStore();
    const existing = store.create('iphash', 'ua');
    const { buffer, pushed } = recordingBuffer();
    const app = tokenApp(buffer, { productId: 'p', tokenStore: store });

    await app.request(`/landing?_t=${existing}`);
    expect(pushed[0]?.visitorToken).toBe(existing);
    expect(store.stats().active).toBe(1); // reused, not a second token
  });

  test('an unknown _t mints a fresh token', async () => {
    const store = makeStore();
    const { buffer, pushed } = recordingBuffer();
    const app = tokenApp(buffer, { productId: 'p', tokenStore: store });

    await app.request('/landing?_t=bogusbogus12');
    const token = pushed[0]?.visitorToken;
    expect(token).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(token).not.toBe('bogusbogus12');
  });

  test('attribution is captured on the token record (first-touch), not stamped on the event', async () => {
    const store = makeStore();
    const { buffer, pushed } = recordingBuffer();
    const app = tokenApp(buffer, { productId: 'p', tokenStore: store });

    await app.request('/landing?utm_source=newsletter&gclid=g1');
    const token = pushed[0]?.visitorToken as string;
    expect(store.get(token)?.attribution).toEqual({ utm_source: 'newsletter', gclid: 'g1' });
    expect(pushed[0]?.attribution ?? {}).toEqual({}); // not on the event
  });

  test('first-touch attribution is not overwritten by a later hit', async () => {
    const store = makeStore();
    const { buffer, pushed } = recordingBuffer();
    const app = tokenApp(buffer, { productId: 'p', tokenStore: store });

    await app.request('/landing?utm_source=first');
    const token = pushed[0]?.visitorToken as string;
    await app.request(`/landing?_t=${token}&utm_source=second`);
    expect(store.get(token)?.attribution).toEqual({ utm_source: 'first' });
  });

  test('with no tokenStore option, no token is minted or exposed', async () => {
    const { buffer, pushed } = recordingBuffer();
    const app = tokenApp(buffer, { productId: 'p' });

    const res = await app.request('/whoami');
    expect(await res.text()).toBe('none');
    expect(pushed[0]?.visitorToken ?? null).toBeNull();
  });

  test('a setAttribution failure keeps the minted token on the event and context', async () => {
    const { buffer, pushed } = recordingBuffer();
    const minted: string[] = [];
    const badAttrStore = {
      get: () => null,
      create: () => {
        const t = `tok${minted.length}`.padEnd(12, '0');
        minted.push(t);
        return t;
      },
      touch: () => {},
      setAttribution: () => {
        throw new Error('attribution boom');
      },
    } as unknown as VisitorTokenStore;
    const app = tokenApp(buffer, { productId: 'p', tokenStore: badAttrStore });

    // utm_source forces setAttribution to run (and throw); the token is already
    // minted and must survive on both the context and the event.
    const res = await app.request('/whoami?utm_source=x');
    expect(res.status).toBe(200);
    const token = minted[0] as string;
    expect(await res.text()).toBe(token); // token exposed in-handler
    expect(pushed[0]?.visitorToken).toBe(token); // and on the event
  });

  test('a throwing tokenStore never crashes the host; the request is still logged sans token', async () => {
    const { buffer, pushed } = recordingBuffer();
    const badStore = {
      get: () => null,
      create: () => {
        throw new Error('store boom');
      },
      touch: () => {},
      setAttribution: () => {},
    } as unknown as VisitorTokenStore;
    const app = tokenApp(buffer, { productId: 'p', tokenStore: badStore });

    const res = await app.request('/landing');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hi');
    expect(pushed).toHaveLength(1); // request event survives the store failure
    expect(pushed[0]?.visitorToken ?? null).toBeNull();
  });
});

describe('requestLogger — client IP resolution', () => {
  test('falls back to the socket address when X-Forwarded-For is absent', async () => {
    const { buffer, pushed } = recordingBuffer();
    const app = appWith(buffer, {
      productId: 'p',
      hashIPs: false,
      getClientAddress: () => '192.0.2.55',
    });

    await app.request('/hello');
    expect((pushed[0]?.context as { ip?: string }).ip).toBe('192.0.2.55');
  });

  test('hashes the socket-derived IP when hashIPs is on', async () => {
    const { buffer, pushed } = recordingBuffer();
    const app = appWith(buffer, { productId: 'p', getClientAddress: () => '192.0.2.55' });

    await app.request('/hello');
    expect((pushed[0]?.context as { ip?: string }).ip).toBe(sha256('192.0.2.55'));
  });

  test('X-Forwarded-For takes precedence over the socket address', async () => {
    const { buffer, pushed } = recordingBuffer();
    const app = appWith(buffer, {
      productId: 'p',
      hashIPs: false,
      getClientAddress: () => 'socket-addr',
    });

    await app.request('/hello', { headers: { 'x-forwarded-for': '203.0.113.7' } });
    expect((pushed[0]?.context as { ip?: string }).ip).toBe('203.0.113.7');
  });

  test('ip is undefined when neither XFF nor a socket address is available', async () => {
    const { buffer, pushed } = recordingBuffer();
    const app = appWith(buffer, { productId: 'p', getClientAddress: () => undefined });

    await app.request('/hello');
    expect((pushed[0]?.context as { ip?: string }).ip).toBeUndefined();
  });

  test('the default socket resolver never throws under app.request (no real socket)', async () => {
    const { buffer, pushed } = recordingBuffer();
    const app = appWith(buffer, { productId: 'p' }); // default getConnInfo-based resolver

    const res = await app.request('/hello');
    expect(res.status).toBe(200);
    expect(pushed).toHaveLength(1); // request logged regardless of socket availability
  });
});
