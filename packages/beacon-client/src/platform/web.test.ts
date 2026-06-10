import { describe, expect, test } from 'bun:test';

import { build, tick } from '../testkit';
import { useBeaconWeb, type WebBindings } from './web';

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
    const throwingGet = () => {
      throw new Error('storage access is forbidden in the web wrapper');
    };
    const storageTrap = { configurable: true, get: throwingGet };
    const hadDocument = 'document' in globalThis;
    const priorDocument = (globalThis as { document?: unknown }).document;
    Object.defineProperty(globalThis, 'localStorage', storageTrap);
    Object.defineProperty(globalThis, 'sessionStorage', storageTrap);
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: Object.defineProperty({}, 'cookie', { configurable: true, get: throwingGet }),
    });
    try {
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
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: undefined });
      Object.defineProperty(globalThis, 'sessionStorage', {
        configurable: true,
        value: undefined,
      });
      if (hadDocument) {
        Object.defineProperty(globalThis, 'document', {
          configurable: true,
          value: priorDocument,
        });
      } else {
        delete (globalThis as { document?: unknown }).document;
      }
    }
  });
});
