import { describe, expect, test } from 'bun:test';

import { allEvents, build, tick, withStorageTrap } from '../testkit';
import { type NavBindings, useBeaconNav, useBeaconWeb, type WebBindings } from './web';

/** This suite logs as a web client; the kit's build() defaults to ios, so pass web here. */
const WEB_CONTEXT = { appVersion: '1.0.0', platform: 'web' as const };

/** Fake DOM bindings: drive visibility + lifecycle events and record sendBeacon calls by hand. */
function makeWeb(initialVisibility = 'visible') {
  let visibilityState = initialVisibility;
  const docListeners = new Map<string, () => void>();
  const winListeners = new Map<string, () => void>();
  const removed: string[] = [];
  const beacons: Array<{ url: string; blob: Blob }> = [];
  const web: WebBindings = {
    document: {
      get visibilityState() {
        return visibilityState;
      },
      addEventListener: (type, listener) => {
        docListeners.set(type, listener);
      },
      removeEventListener: (type) => {
        removed.push(`doc:${type}`);
        docListeners.delete(type);
      },
    },
    window: {
      addEventListener: (type, listener) => {
        winListeners.set(type, listener);
      },
      removeEventListener: (type) => {
        removed.push(`win:${type}`);
        winListeners.delete(type);
      },
    },
    navigator: {
      sendBeacon: (url, blob) => {
        beacons.push({ url, blob });
        return true;
      },
    },
  };
  return {
    web,
    setVisibility: (s: string) => {
      visibilityState = s;
    },
    fireDoc: (type: string) => docListeners.get(type)?.(),
    fireWin: (type: string) => winListeners.get(type)?.(),
    removed,
    beacons,
  };
}

describe('useBeaconWeb', () => {
  test('flushes when the document becomes hidden', async () => {
    const { client, calls } = build({ appContext: WEB_CONTEXT });
    const web = makeWeb('visible');
    useBeaconWeb(client, web.web);

    client.track('button_tap');
    web.setVisibility('hidden');
    web.fireDoc('visibilitychange');
    await tick();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.body.events[0]?.event_type).toBe('button_tap');
  });

  test('does not flush while the document is still visible', async () => {
    const { client, calls } = build({ appContext: WEB_CONTEXT });
    const web = makeWeb('visible');
    useBeaconWeb(client, web.web);

    client.track('button_tap');
    web.fireDoc('visibilitychange'); // visibilityState stays 'visible'
    await tick();

    expect(calls).toHaveLength(0);
  });

  test('sends queued events via navigator.sendBeacon on beforeunload', async () => {
    const { client } = build({ appContext: WEB_CONTEXT });
    const web = makeWeb();
    useBeaconWeb(client, web.web);

    client.screenView('HomeScreen');
    web.fireWin('beforeunload');

    expect(web.beacons).toHaveLength(1);
    const beacon = web.beacons[0];
    if (!beacon) throw new Error('expected one beacon');
    expect(beacon.url).toBe('https://ingest.test/events');
    const payload = JSON.parse(await beacon.blob.text());
    expect(payload.product_id).toBe('clipcast');
    expect(payload.events[0]).toMatchObject({
      event_type: 'screen_view',
      properties: { screen: 'HomeScreen' },
    });
  });

  test('cleanup removes both listeners', () => {
    const { client } = build({ appContext: WEB_CONTEXT });
    const web = makeWeb();
    const cleanup = useBeaconWeb(client, web.web);
    cleanup();
    expect(web.removed).toContain('doc:visibilitychange');
    expect(web.removed).toContain('win:beforeunload');
  });

  test('touches no client-side storage APIs', async () => {
    // Booby-trap the storage globals AND a global document.cookie: any read throws. A future
    // refactor that reaches for global localStorage/sessionStorage — or, the likeliest cookie
    // mistake, global document.cookie — trips this. The wrapper must touch ONLY the injected
    // `web` bindings, so none of these traps may fire.
    await withStorageTrap('storage access is forbidden in the web wrapper', async () => {
      const { client } = build({ appContext: WEB_CONTEXT });
      const web = makeWeb('hidden');
      const cleanup = useBeaconWeb(client, web.web);
      client.track('e');
      web.fireDoc('visibilitychange');
      web.fireWin('beforeunload');
      await tick();
      cleanup();
      // Reaching here without throwing proves no storage global was read.
      expect(web.beacons.length + web.removed.length).toBeGreaterThan(0);
    });
  });
});

/**
 * Fake History-API bindings: a mutable pathname driven by pushState/replaceState (the path arg
 * mimics location.pathname after the real History API updates synchronously), an external setPath
 * + firePopState to simulate browser back/forward, and a window listener map. Mirrors makeWeb.
 */
function makeNav(initialPath = '/') {
  let pathname = initialPath;
  const winListeners = new Map<string, () => void>();
  const removed: string[] = [];
  const setPathFromUrl = (url?: string | null) => {
    // Mimic real location.pathname: strip query + hash so a query-string-only nav keeps the path.
    if (typeof url === 'string') pathname = url.split(/[?#]/)[0] ?? url;
  };
  const nav: NavBindings = {
    history: {
      pushState: (_data, _unused, url) => setPathFromUrl(url),
      replaceState: (_data, _unused, url) => setPathFromUrl(url),
    },
    get location() {
      return { pathname };
    },
    window: {
      addEventListener: (type, listener) => {
        winListeners.set(type, listener);
      },
      removeEventListener: (type) => {
        removed.push(`win:${type}`);
        winListeners.delete(type);
      },
    },
  };
  return {
    nav,
    /** Navigate via the (possibly wrapped) live history method. */
    push: (path: string) => nav.history.pushState(null, '', path),
    replace: (path: string) => nav.history.replaceState(null, '', path),
    /** Simulate browser back/forward: location is already updated when popstate fires. */
    setPath: (p: string) => {
      pathname = p;
    },
    firePopState: () => winListeners.get('popstate')?.(),
    removed,
  };
}

/** Extract the `path` property of every page_view event POSTed across all recorded calls. */
function pagePaths(calls: ReturnType<typeof build>['calls']): unknown[] {
  return allEvents(calls)
    .filter((e) => e.event_type === 'page_view')
    .map((e) => (e.properties as { path?: unknown } | undefined)?.path);
}

describe('useBeaconNav', () => {
  test('emits an initial page_view for the landing path on wire', async () => {
    const { client, calls } = build({ appContext: WEB_CONTEXT });
    const nav = makeNav('/home');
    useBeaconNav(client, nav.nav);

    await client.flush();
    expect(pagePaths(calls)).toEqual(['/home']);
  });

  test('emits a page_view on pushState to a new path', async () => {
    const { client, calls } = build({ appContext: WEB_CONTEXT });
    const nav = makeNav('/home');
    useBeaconNav(client, nav.nav);

    nav.push('/pricing');
    await client.flush();
    expect(pagePaths(calls)).toEqual(['/home', '/pricing']);
  });

  test('emits a page_view on popstate (back/forward) with the current path', async () => {
    const { client, calls } = build({ appContext: WEB_CONTEXT });
    const nav = makeNav('/home');
    useBeaconNav(client, nav.nav);

    nav.push('/pricing'); // forward to /pricing
    nav.setPath('/home'); // browser back updates location first…
    nav.firePopState(); // …then fires popstate
    await client.flush();
    expect(pagePaths(calls)).toEqual(['/home', '/pricing', '/home']);
  });

  test('does not double-count a same-path replaceState (no duplicate page_view)', async () => {
    const { client, calls } = build({ appContext: WEB_CONTEXT });
    const nav = makeNav('/home');
    useBeaconNav(client, nav.nav);

    nav.replace('/home'); // same path — must not emit
    nav.push('/home'); // same path — must not emit
    await client.flush();
    expect(pagePaths(calls)).toEqual(['/home']);
  });

  test('does not emit for a query-string-only navigation (pathname unchanged)', async () => {
    const { client, calls } = build({ appContext: WEB_CONTEXT });
    const nav = makeNav('/search');
    useBeaconNav(client, nav.nav); // initial /search

    nav.push('/search?q=a'); // pathname still /search → no emit (pathname-only granularity)
    nav.push('/search?q=b'); // still /search → no emit
    await client.flush();
    expect(pagePaths(calls)).toEqual(['/search']);
  });

  test('cleanup restores the original history methods and removes the popstate listener', () => {
    const { client } = build({ appContext: WEB_CONTEXT });
    const nav = makeNav('/home');
    const originalPush = nav.nav.history.pushState;
    const originalReplace = nav.nav.history.replaceState;

    const cleanup = useBeaconNav(client, nav.nav);
    expect(nav.nav.history.pushState).not.toBe(originalPush); // patched while active

    cleanup();
    expect(nav.nav.history.pushState).toBe(originalPush);
    expect(nav.nav.history.replaceState).toBe(originalReplace);
    expect(nav.removed).toContain('win:popstate');
  });

  test('a real client carries the shared visitor_token on nav page_views', async () => {
    // E2E: the nav-emitted page_view rides the same body.visitor_token the client sends for
    // in-page track() — proving nav + clicks share one handle (M1 identity, via buildBody).
    const { client, calls } = build({ appContext: WEB_CONTEXT, visitorToken: 'visitor-1' });
    const nav = makeNav('/home');
    useBeaconNav(client, nav.nav);

    nav.push('/pricing');
    client.track('button_tap'); // in-page event on the same client
    await client.flush();

    expect(pagePaths(calls)).toEqual(['/home', '/pricing']);
    expect(calls.length).toBeGreaterThan(0);
    expect(
      calls.every((c) => (c.body as { visitor_token?: string }).visitor_token === 'visitor-1'),
    ).toBe(true);
  });

  test('touches no client-side storage APIs', async () => {
    // Mirror the lifecycle wrapper's booby-trap: any global storage / document.cookie read throws.
    await withStorageTrap('storage access is forbidden in the nav wrapper', async () => {
      const { client, calls } = build({ appContext: WEB_CONTEXT });
      const nav = makeNav('/home');
      const cleanup = useBeaconNav(client, nav.nav);
      nav.push('/pricing');
      nav.setPath('/home');
      nav.firePopState();
      await client.flush();
      cleanup();
      // Reaching here without throwing proves no storage global was read.
      expect(pagePaths(calls).length).toBeGreaterThan(0);
    });
  });

  test('is idempotent: a second wire on the same history does not double-count', async () => {
    const { client, calls } = build({ appContext: WEB_CONTEXT });
    const nav = makeNav('/home');
    useBeaconNav(client, nav.nav); // wire 1: emits the landing /home + patches history
    useBeaconNav(client, nav.nav); // wire 2: already patched → no-op (no extra landing emit)

    nav.push('/pricing'); // must emit ONCE, not once per stacked patch
    await client.flush();
    expect(pagePaths(calls)).toEqual(['/home', '/pricing']);
  });

  test('a duplicate wire returns a no-op cleanup that leaves the first wire intact', () => {
    const { client } = build({ appContext: WEB_CONTEXT });
    const nav = makeNav('/home');
    const original = nav.nav.history.pushState;

    const stop1 = useBeaconNav(client, nav.nav);
    const stop2 = useBeaconNav(client, nav.nav); // no-op wire

    stop2(); // must NOT unpatch — the first wire is still the active owner
    expect(nav.nav.history.pushState).not.toBe(original);

    stop1(); // the real owner restores
    expect(nav.nav.history.pushState).toBe(original);
  });
});
