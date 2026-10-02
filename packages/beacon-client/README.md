# @pi-innovations/beacon-client

Lightweight, dependency-free TypeScript SDK that batches client-side events to a Beacon
ingest endpoint. Platform-agnostic core + thin, **injection-based** wrappers for React
Native / Expo and the web. The package imports neither `react` nor `react-native` — the
host passes its own instances, so there is no duplicate-React risk across Expo Go, dev
builds, or EAS, and no peer-dependency install is forced on web-only consumers.

## Core

```ts
import { BeaconClient } from '@pi-innovations/beacon-client';

const beacon = new BeaconClient({
  endpoint: 'https://api.clipcast.com/analytics/events',
  productId: 'clipcast',
  appContext: { appVersion: '1.2.0', platform: 'ios' },
  // flushInterval?: 30000 (ms), maxBatchSize?: 50, storage?, getHeaders?
});

beacon.track('button_tap', { button: 'create_clip' });
beacon.screenView('HomeScreen');
await beacon.flush();   // also fires on the interval timer and at maxBatchSize
```

The client attaches the `X-App-Context` header (from `appContext`) to every POST so the
server captures device/app context. Reuse it on your other API calls via
`beacon.getContextHeaders()`.

## Expo / React Native

The wrapper takes the React + React Native primitives as an injected `rn` bindings object
(`@pi-innovations/beacon-client/react-native`). Wire it once in your root component, passing
a **stable** reference:

```tsx
import { useEffect } from 'react';
import { AppState, Platform, Dimensions } from 'react-native';
import { BeaconClient } from '@pi-innovations/beacon-client';
import { useBeaconLifecycle, getDeviceContext } from '@pi-innovations/beacon-client/react-native';

const RN = { useEffect, AppState, Platform, Dimensions };

const beacon = new BeaconClient({
  endpoint: 'https://api.clipcast.com/analytics/events',
  productId: 'clipcast',
  appContext: { appVersion: '1.2.0', platform: 'ios', ...getDeviceContext(RN) }, // adds os + screen
  // device model: merge Device.modelName from `expo-device` yourself if you want it
});

export function App() {
  // flush on background; track an `app_foreground` marker on foreground (never tears down,
  // so unsent events survive); unsubscribe on unmount.
  useBeaconLifecycle(beacon, RN);
  return /* … */;
}
```

Screen tracking takes React primitives separately. Pass your router's matched route pattern,
never a concrete path (for example, `/clips/[id]`, never `/clips/123`). The first non-null
route emits on mount; changes emit once, repeated routes are deduped, and null is ignored.
Each hook instance keeps its own last emitted route.

```tsx
import { useEffect, useRef } from 'react';
import { useBeaconScreenViews } from '@pi-innovations/beacon-client/react-native';

const REACT = { useEffect, useRef };

export function ScreenTracking({ route }: { route: string | null }) {
  useBeaconScreenViews(beacon, route, REACT);
  return null;
}
```

The same Expo bundle on web uses `useBeaconScreenViews`, not `useBeaconNav`, so app
and web report identical route names. Supply the same route patterns on both platforms.

## Web

```ts
import { useBeaconWeb } from '@pi-innovations/beacon-client/web';

// flush on visibilitychange→hidden; reliable delivery on beforeunload via navigator.sendBeacon.
const cleanup = useBeaconWeb(beacon, { document, window, navigator });
// call cleanup() to remove the listeners. No cookies / localStorage / sessionStorage.
```

## Notes

- **No build step**: the package ships TypeScript source via its `exports` map; bun and
  Metro/Expo compile it directly. (`.`, `./react-native`, `./web`.)
- **Optional durable queue**: pass a host-supplied `storage` adapter (`load`/`save`/`clear`)
  to persist the outbound queue across app kills on mobile. It holds only undelivered event
  payloads — no identifiers — and is cleared on a successful flush.

## Navigation path normalization

`useBeaconNav(client, nav, { toPath })` maps the initial landing pathname and each
changed pathname before enqueueing a `page_view`. Omitting `toPath` preserves the
pathname. Raw pathnames drive deduplication: two different ids still produce two
views even when both map to the same pattern. A `null` result emits nothing; a throw
emits nothing and reports a sanitized `console.error`. Later navigation still works.
An empty string is retained. Cleanup restores the history methods and removes the
popstate listener. The wrapper uses only injected bindings, with no cookies or storage.

Use an idempotent mapping: the server's `normalizePath` will run again on the client
output. Already-patterned input must map to itself. This self-contained helper accepts
your existing client and History API bindings:

```ts
import type { BeaconClient } from '@pi-innovations/beacon-client';
import { type NavBindings, useBeaconNav } from '@pi-innovations/beacon-client/web';

export function normalizePath(path: string): string | null {
  if (path.startsWith('/invitations/')) return null;
  return /^\/p\/[^/]+\/story\/[^/]+$/.test(path)
    ? '/p/[legacyId]/story/[storyId]'
    : path;
}

export function wireNav(client: BeaconClient, nav: NavBindings): () => void {
  return useBeaconNav(client, nav, { toPath: normalizePath });
}
```

Call `wireNav(client, { history, location, window })` once and call its returned cleanup
when removing tracking. The same mapping can be supplied to programmatic server
`createBeacon({ ...config, normalizePath })`; see the integration guide for server scope.
