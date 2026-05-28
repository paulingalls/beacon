# Beacon

Privacy-first, cookie-free analytics for the PI Innovations product portfolio.

Beacon is a self-hosted analytics stack that captures user behavior through server-side request logging and URL-based visitor tracking — no cookies, no third-party scripts, no consent banners. All data flows into a centralized Postgres instance with an agent-accessible query API.

## Packages

| Package | Description |
|---|---|
| `@pi-innovations/beacon` | Server-side Hono middleware, query engine, API router, admin dashboard, and URL shortener |
| `@pi-innovations/beacon-client` | Lightweight TypeScript client SDK for mobile and optional web-side event tracking |

## Quick Start

### Install

```bash
bun add @pi-innovations/beacon
```

For mobile apps:

```bash
bun add @pi-innovations/beacon-client
```

### Database Setup

Beacon requires a PostgreSQL instance. Run the migrations to create the required tables:

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
    postgres: { connectionString: process.env.DATABASE_URL },
    getUserId: (c) => c.get('userId') ?? null,
    isAdmin: (c) => c.get('role') === 'admin',
});

// Attach middleware to capture all requests
app.use('*', beacon.middleware());

// Mount the query API and admin dashboard
app.route('/analytics', beacon.router());

export default app;
```

### Visitor Token Propagation

For pre-auth visitor tracking, include the visitor token in internal links rendered by your app:

```typescript
app.get('/landing', (c) => {
    const token = beacon.getVisitorToken(c);
    return c.html(`
        <a href="/features?_t=${token}">See Features</a>
        <a href="/pricing?_t=${token}">Pricing</a>
        <a href="/signup?_t=${token}">Sign Up</a>
    `);
});
```

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

Log product-specific events from your route handlers:

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

Mount the shortener on a separate app or domain:

```typescript
import { Hono } from 'hono';
import { createBeacon } from '@pi-innovations/beacon';

const shortApp = new Hono();

const beacon = createBeacon({
    productId: 'global',
    postgres: { connectionString: process.env.DATABASE_URL },
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
// => { code: 'xK4mQ', url: 'https://pi.ink/xK4mQ' }
```

## Mobile Client SDK

### Setup

```typescript
import { BeaconClient } from '@pi-innovations/beacon-client';

const beacon = new BeaconClient({
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
beacon.screenView('HomeScreen');

// Custom events
beacon.track('clip_played', { clipId: 'abc123', duration: 45 });

// Manual flush (e.g., before logout)
await beacon.flush();
```

### React Native Integration

```typescript
import { useBeaconLifecycle } from '@pi-innovations/beacon-client/react-native';

function App() {
    // Automatically flushes on background, resets on foreground
    useBeaconLifecycle(beacon);

    return <MainNavigator />;
}
```

### HTTP Context Header

Attach the app context header to your HTTP client so the server middleware can capture device info:

```typescript
const headers = beacon.getContextHeaders();
// => { 'X-App-Context': '{"appVersion":"1.2.0","platform":"ios","os":"iOS 18.2","device":"iPhone 16","screen":"393x852"}' }

// Attach to your fetch/axios instance
fetch('/api/clips', { headers: { ...headers, ...otherHeaders } });
```

## Query API

All endpoints are mounted under the configured base path (default `/analytics`).

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

## Agent Integration

Beacon's query API is designed for direct use by AI agents. The `/analytics/schema` endpoint provides full introspection so an agent can discover the data model and construct appropriate queries without prior knowledge.

Beacon can also be exposed as an MCP server, enabling Claude (via Claude Code, chat, or custom agent configurations) to connect directly and query analytics data across the full PI Innovations portfolio.

## Configuration Reference

| Option | Type | Default | Description |
|---|---|---|---|
| `productId` | `string` | *required* | Identifier for the host product |
| `postgres.connectionString` | `string` | *required* | Postgres connection string |
| `getUserId` | `(c: Context) => string \| null` | `() => null` | Extract authenticated user ID from Hono context |
| `isAdmin` | `(c: Context) => boolean` | `() => false` | Gate access to the admin dashboard |
| `basePath` | `string` | `'/analytics'` | Mount point for API and dashboard routes |
| `visitorTokenTTL` | `number` | `1800000` (30 min) | Visitor token time-to-live in milliseconds |
| `flushInterval` | `number` | `5000` | Event buffer flush interval in milliseconds |
| `maxBatchSize` | `number` | `100` | Max events per flush batch |
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

# Local dev server
bun run dev

# Run database migrations
DATABASE_URL=postgres://... bun run migrate

# Build packages
bun run build
```

## Documentation

Design specs and the phased build plan live in the [`docs/`](./docs) directory:

| Document | Purpose |
|---|---|
| [`docs/BEACON_OVERVIEW.md`](./docs/BEACON_OVERVIEW.md) | Product overview and design rationale |
| [`docs/REQUIREMENTS.md`](./docs/REQUIREMENTS.md) | The implementation contract — every field, endpoint, and configuration option |
| [`docs/MILESTONES.md`](./docs/MILESTONES.md) | Master build plan and index to the phase documents |
| `docs/phases/PHASE_1_FOUNDATION.md` … `docs/phases/PHASE_8_CLIENT_SDK.md` | Detailed milestones for each build phase |

## License

Private — PI Innovations, LLC. All rights reserved.
