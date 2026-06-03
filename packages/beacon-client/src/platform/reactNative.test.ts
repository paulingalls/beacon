import { describe, expect, test } from 'bun:test';

import type { AppContext } from '../context/appContext';
import { BeaconClient } from '../core/client';
import type { BeaconClientDeps } from '../core/types';
import { getDeviceContext, type ReactNativeBindings, useBeaconLifecycle } from './reactNative';

const APP_CONTEXT: AppContext = { appVersion: '1.0.0', platform: 'ios' };

/** Let a fire-and-forget flush chain settle. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

interface RecordedCall {
  body: { product_id?: string; events: Array<Record<string, unknown>> };
}

/** Records each POST; always 202. */
function makeFetch() {
  const calls: RecordedCall[] = [];
  const fetchFn = (async (_url: string, opts: { body: string }) => {
    calls.push({ body: JSON.parse(opts.body) });
    return { ok: true, status: 202, headers: { get: () => null } };
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

/** Non-firing interval seam so the client's timer never auto-flushes during a test. */
function makeTimer(): Pick<BeaconClientDeps, 'setInterval' | 'clearInterval'> {
  return {
    setInterval: (() =>
      1 as unknown as ReturnType<typeof setInterval>) as BeaconClientDeps['setInterval'],
    clearInterval: (() => {}) as BeaconClientDeps['clearInterval'],
  };
}

/** Fake React Native bindings: drive AppState transitions and component unmount by hand. */
function makeRN(
  opts: { os?: string; version?: string | number; width?: number; height?: number } = {},
) {
  let changeListener: ((state: string) => void) | undefined;
  let cleanup: (() => void) | undefined;
  let subscribeCount = 0;
  let removed = false;
  const rn: ReactNativeBindings = {
    useEffect: (effect) => {
      cleanup = effect() ?? undefined;
    },
    AppState: {
      addEventListener: (_type, listener) => {
        subscribeCount += 1;
        changeListener = listener;
        return {
          remove: () => {
            removed = true;
          },
        };
      },
    },
    Platform: { OS: opts.os ?? 'ios', Version: opts.version ?? 17 },
    Dimensions: { get: () => ({ width: opts.width ?? 393, height: opts.height ?? 852 }) },
  };
  return {
    rn,
    fire: (state: string) => changeListener?.(state),
    unmount: () => cleanup?.(),
    get subscribeCount() {
      return subscribeCount;
    },
    get removed() {
      return removed;
    },
  };
}

function makeClient(calls?: { fetchFn: typeof fetch }) {
  const fetchStub = calls ?? makeFetch();
  return new BeaconClient(
    { endpoint: 'https://ingest.test/events', productId: 'clipcast', appContext: APP_CONTEXT },
    { fetch: fetchStub.fetchFn, ...makeTimer() },
  );
}

describe('useBeaconLifecycle', () => {
  test('subscribes to AppState on mount', () => {
    const rn = makeRN();
    useBeaconLifecycle(makeClient(), rn.rn);
    expect(rn.subscribeCount).toBe(1);
  });

  test('unsubscribes on unmount', () => {
    const rn = makeRN();
    useBeaconLifecycle(makeClient(), rn.rn);
    rn.unmount();
    expect(rn.removed).toBe(true);
  });

  test('flushes on active→background', async () => {
    const fetch = makeFetch();
    const client = makeClient(fetch);
    const rn = makeRN();
    useBeaconLifecycle(client, rn.rn);

    client.track('button_tap');
    rn.fire('background');
    await tick();

    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]?.body.events[0]?.event_type).toBe('button_tap');
  });

  test('tracks an app_foreground marker on background→active (not a teardown)', async () => {
    const fetch = makeFetch();
    const client = makeClient(fetch);
    const rn = makeRN();
    useBeaconLifecycle(client, rn.rn);

    rn.fire('background'); // real backgrounding
    await tick();
    rn.fire('active'); // real foreground → marker
    await client.flush();

    const marker = fetch.calls
      .flatMap((c) => c.body.events)
      .find((e) => e.event_type === 'app_foreground');
    expect(marker).toBeDefined();

    // The foreground path must NOT shut the client down: a fresh event still queues and flushes.
    client.track('post_foreground_tap');
    await client.flush();
    const after = fetch.calls
      .flatMap((c) => c.body.events)
      .find((e) => e.event_type === 'post_foreground_tap');
    expect(after).toBeDefined();
  });

  test('emits one app_foreground per real cycle (wasBackground resets each foreground)', async () => {
    const fetch = makeFetch();
    const client = makeClient(fetch);
    const rn = makeRN();
    useBeaconLifecycle(client, rn.rn);

    rn.fire('background');
    await tick();
    rn.fire('active'); // marker #1
    await tick();
    rn.fire('background');
    await tick();
    rn.fire('active'); // marker #2 — only fires if wasBackground was reset to false after #1
    await client.flush();

    const markers = fetch.calls
      .flatMap((c) => c.body.events)
      .filter((e) => e.event_type === 'app_foreground');
    expect(markers).toHaveLength(2);
  });

  test('Android unknown state is a no-op (no flush, no marker)', async () => {
    const fetch = makeFetch();
    const client = makeClient(fetch);
    const rn = makeRN({ os: 'android', version: 34 });
    useBeaconLifecycle(client, rn.rn);

    client.track('button_tap');
    rn.fire('unknown'); // Android-only AppState value — neither background nor active
    await tick();

    expect(fetch.calls).toHaveLength(0);
  });

  test('double background is harmless — the second flush coalesces', async () => {
    const fetch = makeFetch();
    const client = makeClient(fetch);
    const rn = makeRN();
    useBeaconLifecycle(client, rn.rn);

    client.track('button_tap');
    rn.fire('background');
    rn.fire('background'); // redundant — must not double-POST the same queued event
    await tick();

    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]?.body.events).toHaveLength(1);
  });

  test('does NOT emit a foreground marker on a transient inactive→active (no prior background)', async () => {
    const fetch = makeFetch();
    const client = makeClient(fetch);
    const rn = makeRN();
    useBeaconLifecycle(client, rn.rn);

    rn.fire('inactive'); // e.g. Control Center — no real background
    rn.fire('active');
    await client.flush();

    expect(fetch.calls.flatMap((c) => c.body.events)).toHaveLength(0);
  });

  test('E2E: backgrounding with a queued event POSTs the batch to the ingest endpoint', async () => {
    const fetch = makeFetch();
    const client = makeClient(fetch);
    const rn = makeRN();
    useBeaconLifecycle(client, rn.rn);

    client.screenView('HomeScreen');
    rn.fire('background');
    await tick();

    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]?.body.product_id).toBe('clipcast');
    expect(fetch.calls[0]?.body.events[0]).toMatchObject({
      event_type: 'screen_view',
      properties: { screen: 'HomeScreen' },
    });
  });
});

describe('getDeviceContext', () => {
  test('returns os and screen merge fields from Platform + Dimensions', () => {
    const rn = makeRN({ os: 'ios', version: 17, width: 393, height: 852 });
    expect(getDeviceContext(rn.rn)).toEqual({ os: 'ios 17', screen: '393x852' });
  });

  test('rounds fractional screen dimensions', () => {
    const rn = makeRN({ os: 'android', version: 34, width: 411.4, height: 914.3 });
    expect(getDeviceContext(rn.rn)).toEqual({ os: 'android 34', screen: '411x914' });
  });
});
