import { afterEach, describe, expect, test } from 'bun:test';
import type { BeaconEvent } from '@pi-innovations/beacon-sdk';
import { Hono } from 'hono';
import type { EventBuffer } from '../events/buffer';
import { VisitorTokenStore } from '../visitors/tokenStore';
import { type RequestLoggerOptions, requestLogger } from './requestLogger';

/** A recording stand-in for EventBuffer — the middleware only calls push(). */
function recordingBuffer(): { buffer: EventBuffer; pushed: BeaconEvent[] } {
  const pushed: BeaconEvent[] = [];
  const buffer = { push: (e: BeaconEvent) => pushed.push(e) } as unknown as EventBuffer;
  return { buffer, pushed };
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
