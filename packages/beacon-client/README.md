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
