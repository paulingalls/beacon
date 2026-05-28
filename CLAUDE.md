# CLAUDE.md — Beacon

This file provides context for Claude Code sessions working on Beacon, PI Innovations' first-party analytics platform.

---

## What Is Beacon

Beacon is a privacy-first, cookie-free analytics stack shared across all PI Innovations products. It consists of two packages and a centralized Postgres data store:

- `@pi-innovations/beacon` — Server-side Hono middleware, event helpers, query/aggregation engine, API router, and admin dashboard
- `@pi-innovations/beacon-client` — Lightweight TypeScript client SDK for mobile (React Native/Expo) and optional web-side event tracking

All analytics data flows into a single Postgres database with `product_id` as a first-class dimension. The query API is designed to be agent-accessible (and eventually exposed as an MCP server).

---

## Repo Structure

```
beacon/
├── docs/                           # Specs and phased build plan (see Related Documents)
│   └── phases/                     # Per-phase build documents (PHASE_1 … PHASE_8)
├── packages/
│   ├── beacon/                     # Server package
│   │   ├── src/
│   │   │   ├── middleware/         # Hono middleware (request logging, visitor token, attribution capture)
│   │   │   ├── events/            # Event helpers for custom product events
│   │   │   ├── storage/           # Postgres adapter, schema, migrations
│   │   │   ├── query/             # Query engine (events, aggregations, funnels, attribution)
│   │   │   ├── api/               # Hono API router (/analytics/* endpoints)
│   │   │   ├── dashboard/         # Simple admin dashboard (HTML, served behind auth)
│   │   │   ├── shortener/         # URL shortener route and storage
│   │   │   └── index.ts           # Public API exports
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── beacon-client/             # Client SDK package
│       ├── src/
│       │   ├── core/              # Event queue, batching, flush logic (plain TypeScript)
│       │   ├── platform/          # Platform wrappers (React Native lifecycle hooks)
│       │   ├── context/           # Device/app context header builder
│       │   └── index.ts           # Public API exports
│       ├── package.json
│       └── tsconfig.json
├── CLAUDE.md
├── README.md
├── package.json                   # Workspace root
└── tsconfig.base.json
```

---

## Tech Stack & Conventions

- **Runtime:** Bun (latest stable)
- **Server framework:** Hono
- **Database:** PostgreSQL (via `postgres` — the `postgres.js` driver, not `pg`)
- **Language:** TypeScript (strict mode)
- **Monorepo:** Bun workspaces
- **Testing:** `bun:test`
- **No heavy frameworks.** No ORMs. No Redux. No unnecessary abstractions. Write direct SQL for queries, thin wrappers only where they add clarity.
- **Minimal dependencies.** Prefer built-in Bun/Node APIs over npm packages. Every dependency must earn its place.
- **No client-side storage of tracking state.** Beacon must never set cookies or use localStorage, sessionStorage, IndexedDB, or any browser/device storage API to hold visitor identifiers, user IDs, or any cross-session tracking state. This is a hard architectural constraint, not a preference. **Exception:** a transient on-device *outbound event queue* — a send buffer of not-yet-delivered events that is cleared the moment a flush succeeds — is permitted. It carries no identifiers and exists only so mobile apps don't silently lose queued events when the OS kills them mid-session. See `docs/phases/PHASE_8_CLIENT_SDK.md`.

---

## Key Architecture Decisions

### Server Middleware

The core middleware is a Hono middleware function that:

1. Checks for an authenticated user ID (from whatever auth mechanism the host app uses — passed via config callback)
2. Checks for a visitor token in the `_t` query parameter
3. If no user and no token, generates a new visitor token
4. Captures request metadata: path, method, IP, user-agent, referrer, accept-language, timestamp
5. Captures attribution params from the URL: UTM tags, gclid, fbclid, custom params
6. Logs the event to Postgres
7. Exposes the visitor token on the Hono context so the host app can include it in rendered links

The middleware must not block the request. Event logging should be fire-and-forget (write to an in-memory buffer that flushes to Postgres in batches).

### Visitor Token Propagation

- The host app is responsible for appending `?_t={token}` to internal links in rendered HTML
- Beacon provides a helper to retrieve the current token from Hono context
- Tokens are short-lived (configurable TTL, default 30 minutes)
- On authentication, the host app calls a Beacon helper to associate the visitor token with the authenticated user ID

### Attribution Capture

- UTM params and click IDs are extracted from the request URL on first hit
- Stored in an in-memory map keyed by visitor token (or IP+user-agent as fallback)
- Flushed to the user's attribution record on auth association
- TTL matches visitor token TTL

### Event Schema

All events share this structure in Postgres:

```sql
CREATE TABLE beacon_events (
    event_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id      TEXT NOT NULL,
    timestamp       TIMESTAMPTZ NOT NULL DEFAULT now(),  -- event time (client clock)
    received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),  -- ingest time (server clock)
    event_type      TEXT NOT NULL,
    user_id         TEXT,
    visitor_token   TEXT,
    platform        TEXT NOT NULL DEFAULT 'web',
    properties      JSONB NOT NULL DEFAULT '{}',
    context         JSONB NOT NULL DEFAULT '{}',
    attribution     JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_beacon_events_product_time ON beacon_events (product_id, timestamp DESC);
CREATE INDEX idx_beacon_events_user ON beacon_events (user_id, timestamp DESC) WHERE user_id IS NOT NULL;
CREATE INDEX idx_beacon_events_visitor ON beacon_events (visitor_token) WHERE visitor_token IS NOT NULL;
CREATE INDEX idx_beacon_events_type ON beacon_events (product_id, event_type, timestamp DESC);
```

> The authoritative schema lives in `REQUIREMENTS.md` §4.1 and the applied migration `packages/beacon/src/storage/migrations/001_initial_schema.sql`. The blocks here are a quick reference kept in sync with them.

### URL Shortener

```sql
CREATE TABLE beacon_short_links (
    code            TEXT PRIMARY KEY,
    destination     TEXT NOT NULL,
    product_id      TEXT NOT NULL,
    campaign        JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ,
    click_count     INTEGER NOT NULL DEFAULT 0
);
```

- Redirect route: `GET /:code` → lookup, log click event, 302 redirect
- Campaign metadata is stored on the link record, not as URL params on the destination
- Click events are standard beacon_events with event_type `short_link_click`

### Query API

Five endpoints, all mounted under a configurable base path (default `/analytics`):

| Endpoint | Method | Purpose |
|---|---|---|
| `/analytics/schema` | GET | Introspection: available event types, fields, dimensions, time ranges |
| `/analytics/events` | GET | Filtered event stream with pagination |
| `/analytics/aggregate` | GET | Counts, uniques, grouped by any dimension |
| `/analytics/funnel` | GET | Ordered event sequence conversion rates |
| `/analytics/attribution` | GET | Campaign and source performance breakdown |

All endpoints accept `product_id` as an optional filter. When omitted, queries span all products.

The schema endpoint is critical for agent integration — it must be comprehensive enough that an agent with no prior knowledge can discover what to query.

### Admin Dashboard

- Simple server-rendered HTML page (no React, no build step)
- Mounted at a configurable path (default `/analytics/dashboard`)
- Protected by a config callback for auth (same pattern as user ID extraction)
- Consumes the same query API endpoints
- Shows: visitor/user counts, top pages, attribution breakdown, basic funnel, product selector

---

## Client SDK (`beacon-client`)

### Core (platform-agnostic TypeScript)

```typescript
interface BeaconClientConfig {
    endpoint: string;          // e.g., "https://api.clipcast.com/analytics/events"
    productId: string;
    flushInterval?: number;    // ms, default 30000
    maxBatchSize?: number;     // default 50
    appContext: {
        appVersion: string;
        platform: 'ios' | 'android' | 'web';
        // Additional fields populated by platform wrapper
    };
    storage?: BeaconStorageAdapter;  // optional; persists the outbound queue so events survive app kills (mobile)
}

// Optional durable outbound buffer. Holds only undelivered event payloads — no identifiers,
// no tracking state — and is cleared on successful flush. Host app supplies the adapter; the
// SDK adds no storage dependency. See "No client-side storage" exception above.
interface BeaconStorageAdapter {
    load(): Promise<BeaconEvent[]>;
    save(events: BeaconEvent[]): Promise<void>;
    clear(): Promise<void>;
}

interface BeaconEvent {
    eventType: string;
    properties?: Record<string, unknown>;
    timestamp?: string;        // ISO 8601 event time; defaults to server ingest time if omitted
}
```

- Manages an in-memory event queue (plain array), optionally backed by a `storage` adapter for durability
- Flushes via POST to the configured endpoint on interval or when batch size is reached
- Exposes `track(event)`, `screenView(name)`, `flush()`, `reset()`
- Builds the `X-App-Context` header from config for attachment to all outgoing HTTP requests

### Platform Wrappers

- React Native wrapper hooks into `AppState` to flush on background, reset on foreground
- Populates device context automatically (OS, device model, screen dimensions) via React Native APIs
- Web wrapper (optional) hooks into `visibilitychange` and `beforeunload`

---

## Configuration

The server package is configured at initialization:

```typescript
import { createBeacon } from '@pi-innovations/beacon';

const beacon = createBeacon({
    productId: 'clipcast',
    postgres: { connectionString: process.env.DATABASE_URL },
    getUserId: (c) => c.get('userId') ?? null,    // Extract from Hono context
    isAdmin: (c) => c.get('role') === 'admin',     // Gate dashboard access
    basePath: '/analytics',                         // API mount point
    visitorTokenTTL: 30 * 60 * 1000,               // 30 minutes
    flushInterval: 5000,                            // Event buffer flush interval
});

// Mount middleware on all routes
app.use('*', beacon.middleware());

// Mount API and dashboard routes
app.route(beacon.basePath, beacon.router());

// Mount URL shortener (optional, typically on a separate short domain)
app.route('/', beacon.shortener());
```

---

## Build & Development

```bash
# Install dependencies
bun install

# Run tests
bun test

# Run tests for a specific package
bun test --filter beacon
bun test --filter beacon-client

# Dev server (for testing middleware and API locally)
bun run dev

# Build packages
bun run build
```

Database migrations are managed via plain SQL files in `packages/beacon/src/storage/migrations/`. Apply with:

```bash
bun run migrate
```

---

## What Not To Do

- **Never set cookies or store tracking state client-side.** No identifiers in cookies/localStorage/etc. This is the core architectural constraint. (A transient outbound event-queue buffer carrying no identifiers is the one permitted exception — see Tech Stack & Conventions.)
- **Never use an ORM.** Write SQL directly. Use the `postgres.js` driver's tagged template literals.
- **Never add analytics dependencies.** Beacon IS the analytics dependency.
- **Never block requests on event logging.** Buffer and flush asynchronously.
- **Never expose PII in the query API without auth.** All API endpoints must be gated.
- **Never store raw IP addresses long-term.** Hash or truncate for privacy.

---

## Related Documents

All specs and the phased build plan live in the `docs/` directory. Read the relevant ones before starting work on a phase.

| Document | Purpose |
|---|---|
| `docs/BEACON_OVERVIEW.md` | Product overview and design rationale |
| `docs/REQUIREMENTS.md` | The implementation contract — every build decision, field, and config option |
| `docs/MILESTONES.md` | Master phased build plan and the index to the phase documents |
| `docs/phases/PHASE_1_FOUNDATION.md` … `docs/phases/PHASE_8_CLIENT_SDK.md` | Per-phase milestones, each citing the relevant sections of the specs above |
| `README.md` | Setup and usage guide for consumers |

When starting a session for a phase, open its phase document first — it lists which sections of `REQUIREMENTS.md` and `BEACON_OVERVIEW.md` to read for full detail, then reference this file for conventions and repo structure.
