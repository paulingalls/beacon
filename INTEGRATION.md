# Integrating Beacon

How to deploy the Beacon server and wire each kind of product into it. For *what* Beacon is and *why* it's built this way, see [README.md](./README.md).

Beacon follows a **single-writer model**: you deploy **one** Beacon server (the only holder of database credentials), and every product emits events to it over an authenticated `POST /events` boundary. Pick the section below that matches your product.

- [Installation](#installation)
- [Deploying the Beacon server](#deploying-the-beacon-server)
- [Server-side products (Bun.serve / Hono)](#server-side-products-bunserve--hono)
- [Browser SPAs](#browser-spas)
- [Mobile (React Native)](#mobile-react-native)
- [Query API](#query-api)
- [Admin dashboard](#admin-dashboard)
- [Agent integration](#agent-integration)
- [Configuration reference](#configuration-reference)

## Installation

> **Beacon is not published to npm.** Both packages are private (`"private": true`) and ship TypeScript source — there is no `bun add @pi-innovations/beacon-sdk`. Consume Beacon one of three ways:

- **Bun workspace (recommended for a monorepo).** Add Beacon as a workspace member and depend on it with the `workspace:*` protocol — exactly how `apps/server` does in this repo:

  ```jsonc
  // your-app/package.json
  {
    "dependencies": {
      "@pi-innovations/beacon-sdk": "workspace:*"
    }
  }
  ```

- **Git dependency.** Point at the repository (and a subdirectory, since this is a monorepo):

  ```jsonc
  {
    "dependencies": {
      "@pi-innovations/beacon-sdk": "git+ssh://git@github.com/paulingalls/beacon.git#main"
    }
  }
  ```

- **Vendoring.** Copy `packages/beacon` (and `packages/beacon-client` for mobile) into your tree and reference it by relative path. The packages export `.ts` source, so your bundler/runtime must handle TypeScript (Bun does natively).

The published `@pi-innovations/beacon-sdk` package is the **emit SDK** only — it carries no Postgres. The database-writing server is the private `apps/server` app in this repo, which you deploy once (next section).

## Deploying the Beacon server

The Beacon server (`apps/server`) is the single writer: it holds the Postgres credentials and serves ingest (`POST {basePath}/events`), the query API, the admin dashboard, and the URL shortener. Deploy exactly one per environment; every product points at it.

**Prerequisites**

- The Bun runtime and a reachable PostgreSQL instance.
- Migrations applied (idempotent, advisory-locked):

  ```bash
  DATABASE_URL=postgres://user:pass@localhost:5432/beacon bun run migrate
  ```

**Environment**

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string (the one fail-fast). |
| `ADMIN_TOKEN` | no | Bearer token gating the dashboard + query API. **Unset ⇒ those surfaces fail closed (403).** |
| `TRUSTED_INGEST_TOKEN` | no | Bearer secret authorizing a trusted server-to-server caller to assert per-event `user_id`/context in the ingest body. **Unset ⇒ trusted ingest disabled (anonymous-only).** |
| `PRODUCT_ID` | no | Fallback `product_id` for events whose batch omits one (default `beacon`). |
| `PRODUCT_ALLOWLIST` | no | Comma-separated allowlist of accepted `product_id`s. Unset ⇒ accept any. |
| `BASE_PATH` | no | API mount prefix (default `/analytics`). |
| `SHORT_DOMAIN` | no | Absolute base for generated short URLs (e.g. `https://pi.ink`). |
| `PORT` | no | Listen port (default `8080`). |

The canonical, deployable wiring lives in [`apps/server/src/server.ts`](./apps/server/src/server.ts) — `/health` and the query router mount before the shortener's catch-all `GET /:code`, and the admin gate is a constant-time bearer compare that fails closed when `ADMIN_TOKEN` is unset. Deployment to a DigitalOcean droplet (Caddy + systemd, autodeploy on merge to `main`) is covered in [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md).

## Server-side products (Bun.serve / Hono)

A server-side product captures requests and custom events with `createHttpBeacon` and emits them to the deployed Beacon over the trusted ingest boundary — **no Postgres, no Hono required**. It runs under any runtime that exposes the standard `Request`.

```typescript
import { createHttpBeacon } from '@pi-innovations/beacon-sdk';

const beacon = createHttpBeacon({
    productId: 'clipcast',
    endpoint: 'https://beacon.example.com/analytics/events',
    // Authorizes this server to assert per-event user_id/context. Matches the
    // deployed Beacon's TRUSTED_INGEST_TOKEN. Sent as a bearer; never logged.
    trustedIngestToken: process.env.TRUSTED_INGEST_TOKEN!,
    getUserId: (request) => request.headers.get('x-user-id'),
});
```

Log a `request` event for each incoming request. Under `Bun.serve` there is no middleware chain to observe the response, so the host supplies `status`/`responseTimeMs` and the socket address:

```typescript
// inside your Bun.serve fetch handler, where `request: Request` is in scope:
beacon.capture(request, {
    clientAddress: '203.0.113.7',
    status: 200,
    responseTimeMs: 12,
});
```

Record custom product events. `track` is fire-and-forget — it buffers and returns immediately, throwing only on an invalid `event_type` (empty or >100 chars):

```typescript
beacon.track(request, 'clip_created', { clipId: 'abc123', duration: 45 });
```

Drain on shutdown so nothing in flight is lost:

```typescript
process.on('SIGTERM', async () => {
    await beacon.shutdown();
});
```

Visitor identity is carried automatically: `capture`/`track` adopt the `_t` query parameter as the visitor handle (the deployed Beacon owns minting; a product only forwards it).

## Browser SPAs

A browser SPA reports events with the client SDK, posting to the deployed Beacon's `POST /events`. The optional web wrapper flushes on `visibilitychange → hidden` and delivers the final batch via `navigator.sendBeacon` on `beforeunload`. Like the React Native wrapper it takes an injected `web` bindings object (`{ document, window, navigator }`) and uses no cookies or storage:

```typescript
import { useBeaconWeb } from '@pi-innovations/beacon-client/web';

// On a real page you pass the globals directly:
//   const cleanup = useBeaconWeb(client, { document, window, navigator });
const cleanup = useBeaconWeb(client, web);

// Call cleanup() on teardown to remove the listeners.
```

See [Mobile (React Native)](#mobile-react-native) for constructing the `client` and tracking events — the client API is identical on the web.

### Linking the anonymous trail to a user on login

A browser holds only an anonymous `visitorToken` (no cookies, no stored identity), so it cannot assert a `user_id`. When the user logs in, your **server** relays that fact to Beacon over a trusted `POST {basePath}/identify` — the `associateVisitor` equivalent for SPAs. Beacon back-fills the anonymous trail's events with the `user_id` and copies first-touch attribution onto the earliest event. It is gated by the **same** `TRUSTED_INGEST_TOKEN` bearer that gates trusted ingest (a cross-origin browser can't carry your session, so this is server-to-server only):

Mount the supported `createIdentifyRelay` handler on your login route — it reads the SPA's anonymous `visitor_token` from the request body, resolves the authenticated `user_id` from *your* session, and relays the association under the bearer (the secret stays on your server):

```typescript
import { createIdentifyRelay } from '@pi-innovations/beacon-sdk';

// Mount once. `resolveUserId` is YOUR auth — read it from the session/JWT/cookie on
// the request (shown here as a header). The browser sends its anonymous handle in the
// body as `{ visitor_token }`.
const identifyRelay = createIdentifyRelay({
    endpoint: 'https://beacon.example.com/analytics/identify',
    trustedIngestToken: process.env.TRUSTED_INGEST_TOKEN ?? '',
    resolveUserId: (req) => req.headers.get('x-user-id'),
});

// In your login handler, after authenticating:
const res: Response = await identifyRelay(request);
```

- **204 No Content** on success. The back-fill is best-effort and idempotent (re-relaying the same token is a safe no-op), so callers don't need a response body — confirm via the Query API.
- **400** when the request body carries no `visitor_token`, or your `resolveUserId` returns no user (identify needs both).
- **502** when Beacon is unreachable or rejects the bearer — retryable, and the relay never leaks the secret.

## Mobile (React Native)

### Setup

```typescript
import { BeaconClient } from '@pi-innovations/beacon-client';

const client = new BeaconClient({
    endpoint: 'https://beacon.example.com/analytics/events',
    productId: 'clipcast',
    flushInterval: 30000,
    appContext: {
        appVersion: '1.2.0',
        platform: 'ios',
    },
});
```

### Track events

```typescript
// Screen views
client.screenView('HomeScreen');

// Custom events
client.track('clip_played', { clipId: 'abc123', duration: 45 });

// Manual flush (e.g., before logout)
await client.flush();
```

Call `client.shutdown()` to clear the queue, stop the flush timer, and clear any durable store (e.g. on logout).

### Delivery callbacks

All three callbacks are optional and fail-isolated — a throwing callback can never break delivery. They observe each batch POST; they do not change retry/drop behavior:

```typescript
const client = new BeaconClient({
    endpoint: 'https://beacon.example.com/analytics/events',
    productId: 'clipcast',
    appContext: { appVersion: '1.2.0', platform: 'ios' },
    // Accepted (2xx). `productIdUsed` is the server's resolved product_id — lets you
    // detect events attributed to a different product than intended.
    onSent: (events, info) => console.log(`sent ${events.length} (as ${info.productIdUsed})`),
    // The batch was permanently dropped: a server rejection (4xx, info.status) or
    // retry exhaustion after transient failures (info.exhausted). These events are lost.
    onDrop: (events) => console.warn(`dropped ${events.length} events`),
    // Transient failure (5xx / network), retried. On exhaustion the events are dropped
    // and onDrop fires with info.exhausted.
    onError: (events, info) => console.warn(`transient send error (status ${info.status ?? 0})`),
});
```

### Lifecycle wrapper

The wrapper takes an injected `rn` bindings object so the SDK declares no `react`/`react-native` dependency — you pass your own bundled instances (most Expo-robust). Assemble `rn` once at module scope:

```typescript
import { useBeaconLifecycle } from '@pi-innovations/beacon-client/react-native';

// Assemble `rn` from your own imports — see ReactNativeBindings for the exact shape:
//   import { useEffect } from 'react';
//   import { AppState, Platform, Dimensions } from 'react-native';
//   const rn = { useEffect, AppState, Platform, Dimensions };

function App() {
    // Flushes on background; tracks an `app_foreground` marker on a real foreground.
    // It never resets the client — unsent events survive a foreground.
    useBeaconLifecycle(client, rn);

    return <MainNavigator />;
}
```

### HTTP context header

Attach the app context header to your HTTP client so the server can capture device info. The header carries exactly the fields you set in `appContext` (unset optional fields are omitted):

```typescript
const headers = client.getContextHeaders();
// => { 'X-App-Context': '{"appVersion":"1.2.0","platform":"ios"}' }

// Attach to your fetch/axios instance
fetch('/api/clips', { headers: { ...headers, ...otherHeaders } });
```

Populate the optional `os` / `device` / `screen` fields (via the React Native wrapper's `getDeviceContext`, or manually) and they appear in the header too.

### Associating a logged-in user

A mobile app is a distributed binary, so it can't hold the trusted ingest secret — the device stays anonymous (public ingest never honors a body `user_id`). How a user gets attributed depends on whether your product has a backend:

- **Serverless / accountless apps:** there is no cross-session association, by design. The `visitorToken` is in-memory and resets on launch (the no-client-storage rule), so each app session is its own anonymous trail. A persistent device identifier would be a cookie by another name — exactly what Beacon's privacy posture rejects. Measure session-scoped behavior; use accounts when you need a durable cross-session key.

- **Apps with a backend + accounts:** attribution is **server-relayed**. The device talks to your backend, which forwards to Beacon under the `TRUSTED_INGEST_TOKEN` bearer (server-to-server — the same trust boundary the SPA `/identify` relay uses). There are two relays:

**1. Stitch the pre-login trail on login** — one `POST {basePath}/identify` (see [Linking the anonymous trail to a user on login](#linking-the-anonymous-trail-to-a-user-on-login)). It back-fills earlier anonymous events for that `visitor_token` with the real `user_id`.

**2. Attribute events going forward** — mount the supported `createIngestRelay` handler on your backend and point the mobile `BeaconClient`'s `endpoint` at it (not at Beacon directly). It reads the device's batch from the request body, resolves *your* authenticated user, stamps `user_id` on each event, and forwards under the bearer — preserving the device's `visitor_token` and timestamps:

```typescript
import { createIngestRelay } from '@pi-innovations/beacon-sdk';

// Mount once on an authenticated route. `resolveUserId` is YOUR auth (session/JWT);
// the device posts its batch body `{ product_id, visitor_token, events }` here. A
// device-asserted `user_id` is stripped — only the resolved id rides the bearer.
const eventsRelay = createIngestRelay({
    endpoint: 'https://beacon.example.com/analytics/events',
    trustedIngestToken: process.env.TRUSTED_INGEST_TOKEN ?? '',
    resolveUserId: (req) => req.headers.get('x-user-id'),
});

// In your route handler. 204 on success, 400 on a malformed batch, 502 (retryable)
// when Beacon is unreachable — map it straight back to the device.
const res: Response = await eventsRelay(request);
```

Both handlers are also importable from the `@pi-innovations/beacon-sdk/relay` subpath, and expose `relayBatch` / `relayIdentify` primitives if you need to forward an already-parsed batch without the `Request` wrapper.

Once set by either relay, `user_id` is a first-class column read uniformly by the Query API (`/events`, `/aggregate`, `/funnel`, `/attribution`). `visitor_token` links one session; `user_id` is the cross-session key.

## Query API

All endpoints are mounted under the deployed server's base path (default `/analytics`) and are gated by `ADMIN_TOKEN`.

### Schema discovery

```
GET /analytics/schema
```

Returns available event types, fields, dimensions, and time ranges. This is the entry point for agent-driven queries — an agent calls this first to understand what data is available.

### Event stream

```
GET /analytics/events?product_id=clipcast&event_type=clip_created&after=2026-01-01&limit=100
```

Filtered, paginated event stream.

### Aggregations

```
GET /analytics/aggregate?product_id=clipcast&metric=count&group_by=event_type&after=2026-03-01
```

Counts, unique counts, grouped by any available dimension.

### Funnel analysis

```
GET /analytics/funnel?product_id=clipcast&steps=page_view,signup,clip_created&after=2026-03-01
```

Conversion rates between an ordered sequence of events.

### Attribution

```
GET /analytics/attribution?product_id=clipcast&after=2026-03-01
```

Campaign and source performance breakdown with conversion data.

## Admin dashboard

A built-in dashboard is available at `/analytics/dashboard` (configurable). It is protected by the same `ADMIN_TOKEN` bearer as the query API. It shows visitor and user counts, top pages, attribution breakdown, a basic conversion funnel, and a product selector for cross-portfolio views. It consumes the same query API endpoints and serves as both a quick-glance tool and a reference implementation.

## Agent integration

Beacon's query API is designed for direct use by AI agents. The `/analytics/schema` endpoint provides full introspection so an agent can discover the data model and construct appropriate queries without prior knowledge. Beacon can also be exposed as an MCP server, enabling Claude (via Claude Code, chat, or custom agent configurations) to connect directly and query analytics across the full PI Innovations portfolio.

## Configuration reference

`createHttpBeacon(options)` for server-side products (see `HttpBeaconOptions` in `packages/beacon/src/httpBeacon.ts` for the full list):

| Option | Type | Default | Description |
|---|---|---|---|
| `productId` | `string` | *required* | Product this instance emits for (`beacon_events.product_id`). |
| `endpoint` | `string` | *required* | Deployed Beacon ingest URL, e.g. `https://beacon.example.com/analytics/events`. |
| `trustedIngestToken` | `string` | *required* | Trusted-ingest bearer secret; sent as `Authorization: Bearer`, never logged. |
| `getUserId` | `(request: Request) => string \| null` | no user | Resolve the authenticated user id from the request. |
| `hashIPs` | `boolean` | `true` | SHA-256 the client IP before it leaves the product. |
| `flushInterval` | `number` | sink default | Emit-buffer flush interval in milliseconds. |
| `maxBatchSize` | `number` | sink default | Max events per emitted batch. |

The deployed server is configured by environment (see [Deploying the Beacon server](#deploying-the-beacon-server)); its full option set is `BeaconConfig` in `apps/server/src/types.ts`.
