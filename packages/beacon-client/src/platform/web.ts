// Optional web lifecycle wrapper (REQUIREMENTS.md §8.4 / PHASE_8 §8.5). Flushes on
// visibilitychange→hidden (page still alive → a full fetch with X-App-Context/auth headers
// goes out, draining the bulk of the queue), and on beforeunload delivers the most-recent
// batch (≤ maxBatchSize) via navigator.sendBeacon for reliable last-mile delivery — a plain
// fetch without keepalive is cancelled on page-discard. A single beacon can't drain a queue
// larger than maxBatchSize, so the visibilitychange flush is the primary path; the beacon is
// the unload backstop for whatever the hidden-flush didn't already send. DOM
// globals (document/window/navigator) are uninstalled under bun test, so — mirroring the RN
// wrapper's injection — they're passed as a `web` bindings object typed by the local interface
// below; the wrapper touches ONLY that object, never globals and never any storage API.
// Export path: @pi-innovations/beacon-client/web (wired in story-005).

import type { BeaconClient } from '../core/client';

/** The minimal slice of the DOM the wrapper depends on. */
export interface WebBindings {
  document: {
    visibilityState: string;
    addEventListener(type: string, listener: () => void): void;
    removeEventListener(type: string, listener: () => void): void;
  };
  window: {
    addEventListener(type: string, listener: () => void): void;
    removeEventListener(type: string, listener: () => void): void;
  };
  navigator: { sendBeacon(url: string, body: Blob): boolean };
}

/**
 * Wire a BeaconClient to web page-lifecycle events. Returns a cleanup function that removes both
 * listeners. No cookies / localStorage / sessionStorage — sendBeacon covers unload delivery, so
 * the wrapper stays fully storage-free.
 */
export function useBeaconWeb(client: BeaconClient, web: WebBindings): () => void {
  const onVisibilityChange = () => {
    if (web.document.visibilityState === 'hidden') void client.flush();
  };
  const onBeforeUnload = () => {
    client.flushViaBeacon((url, body) =>
      web.navigator.sendBeacon(url, new Blob([body], { type: 'application/json' })),
    );
  };

  web.document.addEventListener('visibilitychange', onVisibilityChange);
  web.window.addEventListener('beforeunload', onBeforeUnload);

  return () => {
    web.document.removeEventListener('visibilitychange', onVisibilityChange);
    web.window.removeEventListener('beforeunload', onBeforeUnload);
  };
}
