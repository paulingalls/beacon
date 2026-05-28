# Phase 8: Client SDK

## Relevant Sections

- `REQUIREMENTS.md` → §8 Client SDK (§8.1 Core Module, §8.2 Context Headers, §8.3 React Native Wrapper, §8.4 Web Wrapper)
- `REQUIREMENTS.md` → §6.2 Client-Side Batch Endpoint (the server endpoint the SDK calls)
- `BEACON_OVERVIEW.md` → Data Collection → Mobile — Client-Side Events, Mobile — Authenticated Users

## Goal

Build `@pi-innovations/beacon-client`, a lightweight TypeScript SDK that collects client-side events (screen views, UI interactions) and batches them to the server's ingest endpoint. The core is platform-agnostic; thin wrappers handle React Native and web lifecycle integration.

---

## Milestones

### 8.1 — Core Event Queue

Build the platform-agnostic event collection and batching engine.

**Deliverables:**

- `packages/beacon-client/src/core/client.ts` — `BeaconClient` class:
  - Constructor accepts `BeaconClientConfig` per `REQUIREMENTS.md` §8.1
  - `track(eventType, properties?)` — creates an event object with timestamp (ISO 8601, `new Date().toISOString()`), pushes to the internal queue
  - `screenView(screenName)` — convenience method, calls `track('screen_view', { screen: screenName })`
  - `flush()` — sends queued events to the configured endpoint via `POST`, returns `Promise<void>`
  - `reset()` — clears the event queue and cancels the flush timer
- Internal queue: plain array, max `500` events. When full, oldest events are dropped (shift from front).
- No external dependencies. Uses `fetch()` (globally available in React Native and modern web).

**Queue durability (mobile).** The in-memory queue is lost if the OS kills the app while events are pending — a real loss on mobile, where backgrounded apps are terminated routinely. The client therefore accepts an optional `storage` adapter in `BeaconClientConfig`:

```typescript
interface BeaconStorageAdapter {
    load(): Promise<BeaconEvent[]>;   // called once on construction to restore a pending queue
    save(events: BeaconEvent[]): Promise<void>;  // called on enqueue/flush-failure to persist
    clear(): Promise<void>;           // called after a successful flush
}
```

- When no adapter is supplied, the queue is purely in-memory (current behavior, fine for web/marketing pages).
- When supplied (e.g., an `AsyncStorage`- or `expo-sqlite`-backed adapter the host app provides), the queue survives app kills. The host app owns the adapter; the SDK adds no storage dependency.
- This is explicitly **permitted** under the "no client-side storage" rule: the buffer holds only undelivered event payloads — no visitor tokens, no user IDs, no cross-session tracking state — and is cleared on flush. See the constraint exception in `CLAUDE.md` → Tech Stack & Conventions.

**Tests (unit, mock fetch):**

- `track()` adds events to the queue with correct shape and timestamp
- `screenView()` creates a `screen_view` event with `screen` property
- Queue caps at 500, drops oldest on overflow
- `reset()` clears the queue

### 8.2 — Flush Logic

**Deliverables:**

- Flush timer: starts on construction, fires every `flushInterval` ms (default `30000`)
- Batch size trigger: flush also fires when queue reaches `maxBatchSize` (default `50`)
- `flush()` sends `POST` to `config.endpoint` with JSON body: `{ "events": [...] }`
  - Includes `X-App-Context` header (see §8.3)
  - Includes any auth headers the host app provides via a `getHeaders()` config callback
- Retry logic per `REQUIREMENTS.md` §8.1:
  - On network failure (fetch throws): re-queue the batch once. If retry also fails, drop events.
  - On `4xx` response: drop events (client error, don't retry)
  - On `5xx` response: re-queue once, drop on second failure
- After successful flush, queue is cleared of the sent events
- `flush()` is a no-op if the queue is empty

**Tests (unit, mock fetch):**

- Timer triggers flush at configured interval
- Batch size trigger fires when queue hits threshold
- Successful flush clears sent events from queue
- Network failure: batch re-queued once, then dropped
- `4xx` response: events dropped immediately
- `5xx` response: batch re-queued once, then dropped
- Empty queue flush is a no-op
- Multiple rapid `flush()` calls don't duplicate sends (guard against concurrent flushes)

### 8.3 — Context Headers

**Deliverables:**

- `getContextHeaders()` method returns a `Record<string, string>` containing the `X-App-Context` header:
  - Value is a JSON string with fields from `config.appContext`
  - Minimum fields: `appVersion`, `platform`
  - Additional fields (populated by platform wrappers or manually): `os`, `device`, `screen`
- The host app uses this to attach the header to ALL outgoing API requests (not just analytics calls), so the server middleware captures device context on every request

**Tests (unit):**

- Returns correctly formatted header with configured context
- JSON value is valid and parseable
- Additional fields from platform wrappers are included when set

### 8.4 — React Native Wrapper

**Deliverables:**

- `packages/beacon-client/src/platform/reactNative.ts`:
  - `useBeaconLifecycle(client)` React hook per `REQUIREMENTS.md` §8.3:
    - Listens to `AppState` changes via React Native's `AppState` API
    - On `active → background`: calls `client.flush()`
    - On `background → active`: calls `client.reset()`
    - Cleans up listener on component unmount
  - `getDeviceContext()` function:
    - Reads `Platform.OS`, `Platform.Version` for OS info
    - Reads `Dimensions.get('window')` for screen dimensions
    - Returns an object suitable for merging into `appContext`
    - Note: device model requires a third-party library (e.g., `expo-device`) — document this as optional, don't add the dependency
- Export path: `@pi-innovations/beacon-client/react-native`

**Tests (unit):**

- Hook subscribes to `AppState` on mount
- Hook unsubscribes on unmount
- Background transition triggers flush
- Foreground transition triggers reset
- `getDeviceContext()` returns expected shape

### 8.5 — Web Wrapper (Optional)

**Deliverables:**

- `packages/beacon-client/src/platform/web.ts`:
  - `useBeaconWeb(client)` function per `REQUIREMENTS.md` §8.4:
    - Listens to `visibilitychange` — calls `client.flush()` when document becomes hidden
    - Listens to `beforeunload` — calls `navigator.sendBeacon()` with queued events for reliable delivery on page close
    - Returns a cleanup function to remove listeners
  - **No cookies, no localStorage, no sessionStorage, no persisted identifiers** — hard constraint. (The web wrapper needs no durable queue: `sendBeacon` on unload covers delivery, so it stays fully storage-free. The optional `storage` adapter from §8.1 is a mobile concern.)
- Export path: `@pi-innovations/beacon-client/web`

**Tests (unit):**

- `visibilitychange` to hidden triggers flush
- `beforeunload` sends via `navigator.sendBeacon()`
- Cleanup function removes all listeners
- The web wrapper itself calls no client-side storage APIs

### 8.6 — Package Exports & Build

**Deliverables:**

- `packages/beacon-client/package.json` exports map:
  - `.` → `src/index.ts` (core client)
  - `./react-native` → `src/platform/reactNative.ts`
  - `./web` → `src/platform/web.ts`
- `packages/beacon-client/src/index.ts` exports: `BeaconClient`, `BeaconClientConfig`, `BeaconEvent` types
- Verify the package works as a git dependency: add `"@pi-innovations/beacon-client": "workspace:*"` in a test consumer, import and instantiate
- No runtime dependencies — the package is pure TypeScript
- React Native wrapper has `react` and `react-native` as peer dependencies
- Web wrapper has no peer dependencies

**Tests:**

- All exports resolve correctly
- TypeScript types are exported and usable
- `bun test --filter beacon-client` passes all tests

---

## Exit Criteria

- `BeaconClient` collects events in memory and flushes them to the server ingest endpoint in batches
- Flush logic handles network failures with single-retry semantics
- React Native wrapper hooks into app lifecycle for automatic flush/reset
- Web wrapper uses `sendBeacon` for reliable delivery on page unload
- No tracking state (identifiers, tokens, user IDs) is ever stored client-side; the only permitted on-device persistence is the optional outbound event-queue adapter (§8.1), which holds undelivered payloads and is cleared on flush
- Context headers provide device info to the server middleware
- Package exports are clean and usable as a git dependency
- All unit tests pass
- `bun test` at root passes (no regressions from Phases 1–7)
