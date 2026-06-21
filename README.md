# Beacon

Privacy-first, cookie-free analytics for the PI Innovations product portfolio.

Beacon is a self-hosted analytics stack that captures user behavior through server-side request logging and URL-based visitor tracking — no cookies, no third-party scripts, no consent banners. All data flows into a centralized Postgres instance with an agent-accessible query API.

## Packages

| Package | Description |
|---|---|
| `@pi-innovations/beacon` | Server-side Hono middleware, query engine, API router, admin dashboard, and URL shortener |
| `@pi-innovations/beacon-client` | Lightweight TypeScript client SDK for mobile and optional web-side event tracking |

## Installation

> **Beacon is not published to npm.** Both packages are private (`"private": true`) and ship TypeScript source — there is no `bun add @pi-innovations/beacon`. Consume Beacon one of three ways:

- **Bun workspace (recommended for a monorepo).** Add Beacon as a workspace member and depend on it with the `workspace:*` protocol — exactly how `apps/server` does in this repo:

  ```jsonc
  // your-app/package.json
  {
    "dependencies": {
      "@pi-innovations/beacon": "workspace:*"
    }
  }
  ```

- **Git dependency.** Point at the repository (and a subdirectory, since this is a monorepo):

  ```jsonc
  {
    "dependencies": {
      "@pi-innovations/beacon": "git+ssh://git@github.com/paulingalls/beacon.git#main"
    }
  }
  ```

- **Vendoring.** Copy `packages/beacon` (and `packages/beacon-client` for mobile) into your tree and reference it by relative path. The packages export `.ts` source, so your bundler/runtime must handle TypeScript (Bun does natively).

Beacon targets the **Bun** runtime and uses the `postgres` (`postgres.js`) driver and **Hono**. Those are peer expectations of the host app, not bundled.

### Database Setup

Beacon requires a PostgreSQL instance. Run the migrations to create the required tables (idempotent, advisory-locked):

```bash
DATABASE_URL=postgres://user:pass@localhost:5432/beacon bun run migrate
```

### Server Integration

Beacon is designed to mount into an existing Hono application:

```typescript
import { Hono } from 'hono';
import { createBeacon } from '@pi-innovations/beacon';

const app = new Hono();

const beacon = createBeacon({
    productId: 'clipcast',
    postgres: { connectionString: process.env.DATABASE_URL! },
    getUserId: (c) => c.get('userId') ?? null,
    isAdmin: (c) => c.get('role') === 'admin',
});

// Attach middleware to capture all requests
app.use('*', beacon.middleware());

// Mount the query API and admin dashboard at the configured base path (default '/analytics')
app.route(beacon.basePath, beacon.router());

export default app;
```

On shutdown, drain buffered events and close Postgres so nothing in flight is lost:

```typescript
process.on('SIGTERM', async () => {
    await beacon.shutdown();
});
```

See `apps/server/src/server.ts` for the canonical, deployable wiring this mirrors.

### Visitor Token Propagation

For pre-auth visitor tracking, append the visitor token to internal links rendered by your app. `appendToken` reads the current request's token from the Hono context and is a no-op when there is none:

```typescript
app.get('/landing', (c) => {
    return c.html(`
        <a href="${beacon.appendToken('/features', c)}">See Features</a>
        <a href="${beacon.appendToken('/pricing', c)}">Pricing</a>
        <a href="${beacon.appendToken('/signup', c)}">Sign Up</a>
    `);
});
```

`beacon.getVisitorToken(c)` returns the raw token (`string | null`) if you need it directly.

### Associate Visitor on Auth

When a user signs up or logs in, link their visitor trail to their user ID:

```typescript
app.post('/auth/signup', async (c) => {
    const user = await createUser(c);
    await beacon.associateVisitor(c, user.id);
    return c.json({ success: true });
});
```

### Custom Events

Log product-specific events from your route handlers. `track` is fire-and-forget — it buffers the event and returns immediately:

```typescript
app.post('/clips', async (c) => {
    const clip = await createClip(c);
    beacon.track(c, 'clip_created', {
        clipId: clip.id,
        duration: clip.duration,
    });
    return c.json(clip);
});
```

### URL Shortener

Mount the shortener at the root of a dedicated short domain (or the same app, after the API routes):

```typescript
import { Hono } from 'hono';
import { createBeacon } from '@pi-innovations/beacon';

const shortApp = new Hono();

const beacon = createBeacon({
    productId: 'global',
    postgres: { connectionString: process.env.DATABASE_URL! },
    shortDomain: 'https://pi.ink',
});

// GET /:code resolves and redirects, logging the click as an event
shortApp.route('/', beacon.shortener());

export default shortApp;
```

Create short links programmatically:

```typescript
const link = await beacon.createShortLink({
    destination: 'https://clipcast.com/signup',
    productId: 'clipcast',
    campaign: {
        source: 'twitter',
        medium: 'social',
        campaign: 'launch-2026',
    },
});
// => { code: 'xK4mQ', destination, url: 'https://pi.ink/xK4mQ', created_at, expires_at }
```

## Mobile Client SDK

### Setup

```typescript
import { BeaconClient } from '@pi-innovations/beacon-client';

const client = new BeaconClient({
    endpoint: 'https://api.clipcast.com/analytics/events',
    productId: 'clipcast',
    flushInterval: 30000,
    appContext: {
        appVersion: '1.2.0',
        platform: 'ios',
    },
});
```

### Track Events

```typescript
// Screen views
client.screenView('HomeScreen');

// Custom events
client.track('clip_played', { clipId: 'abc123', duration: 45 });

// Manual flush (e.g., before logout)
await client.flush();
```

Call `client.shutdown()` to clear the queue, stop the flush timer, and clear any durable store (e.g. on logout).

### Delivery Callbacks

All three callbacks are optional and fail-isolated — a throwing callback can never break delivery. They observe each batch POST; they do not change retry/drop behavior:

```typescript
const client = new BeaconClient({
    endpoint: 'https://api.clipcast.com/analytics/events',
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

### React Native Integration

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

### Web Integration (optional)

A web wrapper flushes on `visibilitychange → hidden` and delivers the last batch via `navigator.sendBeacon` on `beforeunload`. Like the RN wrapper, it takes an injected `web` bindings object (`{ document, window, navigator }`) and uses no cookies or storage:

```typescript
import { useBeaconWeb } from '@pi-innovations/beacon-client/web';

// On a real page you pass the globals directly:
//   const cleanup = useBeaconWeb(client, { document, window, navigator });
const cleanup = useBeaconWeb(client, web);

// Call cleanup() on teardown to remove the listeners.
```

### HTTP Context Header

Attach the app context header to your HTTP client so the server middleware can capture device info. The header carries exactly the fields you set in `appContext` (unset optional fields are omitted):

```typescript
const headers = client.getContextHeaders();
// => { 'X-App-Context': '{"appVersion":"1.2.0","platform":"ios"}' }

// Attach to your fetch/axios instance
fetch('/api/clips', { headers: { ...headers, ...otherHeaders } });
```

Populate the optional `os` / `device` / `screen` fields (via the React Native wrapper's `getDeviceContext`, or manually) and they appear in the header too.

## Query API

All endpoints are mounted under the configured base path (default `/analytics`) and are gated by the `isAdmin` callback.

### Schema Discovery

```
GET /analytics/schema
```

Returns available event types, fields, dimensions, and time ranges. This is the entry point for agent-driven queries — an agent calls this first to understand what data is available.

### Event Stream

```
GET /analytics/events?product_id=clipcast&event_type=clip_created&after=2026-01-01&limit=100
```

Filtered, paginated event stream.

### Aggregations

```
GET /analytics/aggregate?product_id=clipcast&metric=count&group_by=event_type&after=2026-03-01
```

Counts, unique counts, grouped by any available dimension.

### Funnel Analysis

```
GET /analytics/funnel?product_id=clipcast&steps=page_view,signup,clip_created&after=2026-03-01
```

Conversion rates between an ordered sequence of events.

### Attribution

```
GET /analytics/attribution?product_id=clipcast&after=2026-03-01
```

Campaign and source performance breakdown with conversion data.

## Admin Dashboard

A built-in dashboard is available at `/analytics/dashboard` (configurable). It is protected by the `isAdmin` callback provided at initialization.

The dashboard shows visitor and user counts, top pages, attribution breakdown, a basic conversion funnel, and a product selector for cross-portfolio views.

It consumes the same query API endpoints and serves as both a quick-glance tool and a reference implementation.

## Integrating Beacon (for agents)

This section is a copy-paste starting point for wiring Beacon into a host service. It mirrors the deployable reference app at `apps/server/src/server.ts`.

**Prerequisites**

- The Bun runtime and a reachable PostgreSQL instance.
- Beacon installed via one of the paths under [Installation](#installation).
- Migrations applied: `DATABASE_URL=... bun run migrate`.

**Mount order is load-bearing.** Register `/health` and the query router *before* the shortener — the shortener's `GET /:code` is a single-segment catch-all that would otherwise shadow them.

**Environment**

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string |
| `ADMIN_TOKEN` | no | Bearer token gating the dashboard + query API. **Unset ⇒ those surfaces fail closed (403).** |
| `PRODUCT_ID` | no | Fallback product_id for events whose batch omits one (default `beacon`) |
| `BASE_PATH` | no | API mount prefix (default `/analytics`) |
| `SHORT_DOMAIN` | no | Absolute base for generated short URLs (e.g. `https://pi.ink`) |

**Host app template**

```typescript
import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { createBeacon } from '@pi-innovations/beacon';

// Fail-closed admin gate: constant-time compare of `Authorization: Bearer <token>` vs
// ADMIN_TOKEN. Unset token ⇒ every request is non-admin (dashboard/query API unreachable).
const adminToken = process.env.ADMIN_TOKEN;
const expectedDigest = adminToken ? createHash('sha256').update(adminToken).digest() : null;

const hostBeacon = createBeacon({
    productId: process.env.PRODUCT_ID ?? 'beacon',
    postgres: { connectionString: process.env.DATABASE_URL! },
    basePath: process.env.BASE_PATH ?? '/analytics',
    shortDomain: process.env.SHORT_DOMAIN,
    hashIPs: true,
    isAdmin: (c) => {
        if (!expectedDigest) return false;
        const presented = (c.req.header('authorization') ?? '').match(/^Bearer\s+(.+)$/i)?.[1];
        if (presented === undefined) return false;
        return timingSafeEqual(expectedDigest, createHash('sha256').update(presented).digest());
    },
});

const hostApp = new Hono();
hostApp.get('/health', (c) => c.json({ status: 'ok' })); // DB-free probe — keep first
hostApp.route(hostBeacon.basePath, hostBeacon.router());  // query API + dashboard + ingest
hostApp.route('/', hostBeacon.shortener());               // GET /:code — mount LAST (catch-all)

export default hostApp;
```

Deployment of this host app to a DigitalOcean droplet (Caddy + systemd, autodeploy on merge to `main`) is covered in [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md).

## Agent Integration

Beacon's query API is designed for direct use by AI agents. The `/analytics/schema` endpoint provides full introspection so an agent can discover the data model and construct appropriate queries without prior knowledge.

Beacon can also be exposed as an MCP server, enabling Claude (via Claude Code, chat, or custom agent configurations) to connect directly and query analytics data across the full PI Innovations portfolio.

## Configuration Reference

`createBeacon(config)` options (see `BeaconConfig` in `packages/beacon/src/types.ts` for the full list):

| Option | Type | Default | Description |
|---|---|---|---|
| `productId` | `string` | *required* | Identifier for the host product |
| `postgres.connectionString` | `string` | *required* | Postgres connection string |
| `getUserId` | `(c: Context) => string \| null` | no user | Extract authenticated user ID from Hono context |
| `isAdmin` | `(c: Context) => boolean` | `() => false` | Gate the query API + dashboard (missing/throwing ⇒ not admin) |
| `productAllowlist` | `string[]` | accept any | Opt-in allowlist of accepted `product_id`s; `productId` must be included |
| `basePath` | `string` | `'/analytics'` | Mount point for API and dashboard routes |
| `shortDomain` | `string` | `''` (relative) | Absolute base for generated short URLs |
| `visitorTokenTTL` | `number` | `1800000` (30 min) | Visitor token time-to-live in milliseconds |
| `flushInterval` | `number` | `5000` | Event buffer flush interval in milliseconds |
| `maxBatchSize` | `number` | `100` | Max events written per flush batch |
| `hashIPs` | `boolean` | `true` | Hash IP addresses before storage for privacy |

## Privacy

Beacon is designed to operate without cookies or any client-side storage. There is no third-party data sharing, no cross-site tracking, and no persistent client-side identifiers. Visitor tokens exist only as URL parameters during a browsing session and are never stored on the user's device.

This architecture is designed to satisfy GDPR, ePrivacy Directive, and CCPA requirements without cookie consent banners. Consult a privacy attorney for formal compliance confirmation.

## Development

```bash
# Install dependencies
bun install

# Run all tests
bun test

# Run tests for a specific package
bun test --filter beacon
bun test --filter beacon-client

# Local dev server (apps/server, watch mode)
bun run dev

# Run database migrations
DATABASE_URL=postgres://... bun run migrate

# Type-check the workspace (this is what `bun run build` does — no dist is emitted)
bun run typecheck
```

## Documentation

Design specs and the phased build plan live in the [`docs/`](./docs) directory:

| Document | Purpose |
|---|---|
| [`docs/BEACON_OVERVIEW.md`](./docs/BEACON_OVERVIEW.md) | Product overview and design rationale |
| [`docs/REQUIREMENTS.md`](./docs/REQUIREMENTS.md) | The implementation contract — every field, endpoint, and configuration option |
| [`docs/MILESTONES.md`](./docs/MILESTONES.md) | Master build plan and index to the phase documents |
| [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md) | DigitalOcean droplet deployment runbook |
| `docs/phases/PHASE_1_FOUNDATION.md` … `docs/phases/PHASE_8_CLIENT_SDK.md` | Detailed milestones for each build phase |

## License

Private — PI Innovations, LLC. All rights reserved.
