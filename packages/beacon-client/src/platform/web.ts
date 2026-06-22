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

/** The minimal History-API slice the nav wrapper depends on (injected — never globals). */
export interface NavBindings {
  history: {
    pushState(data: unknown, unused: string, url?: string | null): void;
    replaceState(data: unknown, unused: string, url?: string | null): void;
  };
  location: { pathname: string };
  window: {
    addEventListener(type: string, listener: () => void): void;
    removeEventListener(type: string, listener: () => void): void;
  };
}

/**
 * Wire a BeaconClient to client-side History-API navigation. Emits page_view{path} for the
 * landing path on wire, then on each pushState/replaceState/popstate that CHANGES
 * location.pathname — a same-path change is deduped, so a router's replaceState (or a repeated
 * pushState) never double-counts. Path granularity is pathname-only: a query-string-only
 * navigation (same pathname) does not emit. The page_view rides through client.track → buildBody,
 * which attaches the client's visitorToken at send time, so nav and in-page track() share one
 * anonymous handle (M1). Returns a cleanup that restores the patched history methods and removes
 * the popstate listener. Storage-free — touches ONLY the injected `nav` bindings, never globals
 * and never any storage API. Export path: @pi-innovations/beacon-client/web.
 *
 * Wire once per history object. The wrapper does not guard against double-patching, so a second
 * useBeaconNav on the same history would stack page_view emissions.
 */
export function useBeaconNav(client: BeaconClient, nav: NavBindings): () => void {
  let lastPath = nav.location.pathname;
  const emit = () => {
    const path = nav.location.pathname;
    if (path === lastPath) return; // dedup: no page_view when the pathname is unchanged
    lastPath = path;
    client.track('page_view', { path });
  };

  client.track('page_view', { path: lastPath }); // initial landing-page view

  // pushState/replaceState update location synchronously, so emit() reads the NEW pathname.
  const originalPush = nav.history.pushState;
  const originalReplace = nav.history.replaceState;
  nav.history.pushState = function (this: unknown, ...args) {
    originalPush.apply(this, args);
    emit();
  };
  nav.history.replaceState = function (this: unknown, ...args) {
    originalReplace.apply(this, args);
    emit();
  };
  const onPopState = () => emit();
  nav.window.addEventListener('popstate', onPopState);

  return () => {
    nav.history.pushState = originalPush;
    nav.history.replaceState = originalReplace;
    nav.window.removeEventListener('popstate', onPopState);
  };
}
