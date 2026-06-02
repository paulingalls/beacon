# REQUIREMENTS.md — Beacon

This document is the implementation contract for Beacon. It covers every decision a build session needs to make. For high-level context and motivation, see `BEACON_OVERVIEW.md`.

---

## 1. Server Middleware

### 1.1 Request Logging

The middleware attaches to all routes and runs on every inbound request. It must never block or delay the response.

**Captured fields:**

| Field | Source | Notes |
|---|---|---|
| `path` | `c.req.path` | Raw path without query string |
| `method` | `c.req.method` | GET, POST, etc. |
| `status` | Response status code | Captured after handler via `c.res` |
| `response_time_ms` | Calculated | `Date.now()` before/after handler |
| `ip` | `c.req.header('x-forwarded-for')` or socket | First value if comma-separated; SHA-256 hash before storage |
| `user_agent` | `c.req.header('user-agent')` | Stored in `context` JSONB |
| `referrer` | `c.req.header('referer')` | Stored in `context` JSONB |
| `accept_language` | `c.req.header('accept-language')` | First locale only; stored in `context` JSONB |
| `user_id` | `getUserId(c)` callback | Nullable |
| `visitor_token` | `_t` query param or generated | See §2 |
| `attribution` | URL query params | See §3 |
| `app_context` | `X-App-Context` header | Parsed JSON; stored in `context` JSONB. Malformed JSON is silently ignored. |

**Excluded paths:** The middleware accepts an `excludePaths` config option — an array of path prefixes to skip (e.g., `/healthz`, `/favicon.ico`, static asset paths). Exact prefix match.

**Event type:** Middleware-generated events use event_type `request`.

### 1.2 Event Buffer

Events are not written to Postgres inline with the request. They are pushed to an in-memory buffer and flushed in batches.

| Parameter | Config Key | Default |
|---|---|---|
| Flush interval | `flushInterval` | `5000` ms |
| Max batch size | `maxBatchSize` | `100` events |
| Max buffer size | `maxBufferSize` | `10000` events |

**Flush triggers:**

1. Timer fires every `flushInterval` ms
2. Buffer reaches `maxBatchSize` (immediate flush of one batch)
3. `beacon.flush()` called manually (e.g., on graceful shutdown)

**Backpressure:** If the buffer reaches `maxBufferSize`, new events are dropped silently. A counter tracks dropped events and is exposed via `beacon.stats()`.

**Write strategy:** Batched `INSERT` using `postgres.js` tagged template with `UNNEST` arrays for bulk insert. Single round-trip per flush.

**Retry logic:** On Postgres write failure, the batch is re-queued to the front of the buffer (respecting `maxBufferSize` — if full, the batch is dropped). A maximum of 3 retry attempts per batch. Failed batches after 3 retries are dropped and counted in `beacon.stats()`.

**Graceful shutdown:** The host app should call `await beacon.shutdown()` on process exit. This flushes remaining events with a 5-second timeout, then closes the Postgres connection.

### 1.3 Failure Isolation

If Postgres is unreachable at startup, Beacon logs a warning but does not throw. The middleware still attaches and events buffer in memory. Flushes will retry on the normal schedule, and once Postgres recovers, buffered events drain.

If Postgres is unreachable for an extended period and the buffer fills, events are dropped per §1.2 backpressure rules. The host application continues serving requests normally. Beacon must never crash the host app.

---

## 2. Visitor Token

### 2.1 Generation

- Format: 12-character URL-safe random string (`[a-zA-Z0-9]`)
- Generated via `crypto.randomBytes(9).toString('base64url').slice(0, 12)`
- Generated server-side on first hit when no `_t` param is present and no authenticated user is found

### 2.2 Storage

Visitor tokens are held in an in-memory `Map<string, VisitorTokenRecord>`:

```typescript
interface VisitorTokenRecord {
    token: string;
    createdAt: number;
    lastSeenAt: number;
    attribution: Attribution | null;
    ipHash: string;
    userAgent: string;
}
```

**TTL:** Configurable via `visitorTokenTTL`, default `1800000` (30 minutes). TTL is measured from `lastSeenAt` — each request with the token refreshes it (sliding window).

**Eviction:** A sweep runs every 60 seconds, removing expired entries. No LRU — TTL-based only.

**Max entries:** `maxVisitorTokens` config, default `50000`. If the map reaches capacity, the oldest entries (by `lastSeenAt`) are evicted to make room.

### 2.3 Propagation

The middleware exposes the current visitor token on the Hono context:

```typescript
const token = c.get('beaconVisitorToken'); // string | null
```

The host app is responsible for appending `?_t={token}` (or `&_t={token}`) to internal links in rendered HTML. Beacon provides a URL helper:

```typescript
beacon.appendToken(url: string, c: Context): string
```

This helper is a convenience — it reads the token from context and appends it to the given URL, handling existing query string parameters.

### 2.4 Association

When the host app identifies the user (login or signup), it calls:

```typescript
await beacon.associateVisitor(c: Context, userId: string): Promise<void>
```

This:

1. Reads the visitor token from the request context
2. Looks up the `VisitorTokenRecord` in the in-memory map
3. Writes a batch `UPDATE` to `beacon_events` setting `user_id` on all events matching that `visitor_token` where `user_id IS NULL`
4. Copies any `attribution` data from the token record to the user's first event
5. Removes the token from the in-memory map

If no token is found (e.g., user navigated directly to login), this is a no-op.

---

## 3. Attribution

### 3.1 Captured Parameters

| Category | Parameters |
|---|---|
| UTM | `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term` |
| Ad platforms | `gclid`, `fbclid`, `msclkid`, `dclid`, `ttclid`, `li_fat_id` |
| Custom | Any param prefixed with `_bcn_` (e.g., `_bcn_partner=acme`) |

### 3.2 Storage

Attribution data is attached to the `VisitorTokenRecord` on first capture. If a visitor arrives with attribution params, they are stored once and not overwritten by subsequent requests (first-touch attribution).

On visitor association (§2.4), the attribution data is written to the `attribution` JSONB column on the user's first event.

### 3.3 Short Link Attribution

When a request comes through the URL shortener (§7), the campaign metadata stored on the short link record is merged into the attribution data, with the short link's campaign data taking precedence over any URL params.

---

## 4. Event Schema

### 4.1 Tables

```sql
-- Core events table
CREATE TABLE beacon_events (
    event_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id      TEXT NOT NULL,
    timestamp       TIMESTAMPTZ NOT NULL DEFAULT now(),  -- event time: when it happened (client clock)
    received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),  -- ingest time: when the server stored it
    event_type      TEXT NOT NULL,
    user_id         TEXT,
    visitor_token   TEXT,
    platform        TEXT NOT NULL DEFAULT 'web',
    properties      JSONB NOT NULL DEFAULT '{}',
    context         JSONB NOT NULL DEFAULT '{}',
    attribution     JSONB NOT NULL DEFAULT '{}'
);

-- Indexes
CREATE INDEX idx_beacon_events_product_time ON beacon_events (product_id, timestamp DESC);
CREATE INDEX idx_beacon_events_user ON beacon_events (user_id, timestamp DESC) WHERE user_id IS NOT NULL;
CREATE INDEX idx_beacon_events_visitor ON beacon_events (visitor_token) WHERE visitor_token IS NOT NULL;
CREATE INDEX idx_beacon_events_type ON beacon_events (product_id, event_type, timestamp DESC);

-- Short links table
CREATE TABLE beacon_short_links (
    code            TEXT PRIMARY KEY,
    destination     TEXT NOT NULL,
    product_id      TEXT NOT NULL,
    campaign        JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ,
    click_count     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_beacon_short_links_product ON beacon_short_links (product_id);

-- Schema metadata (auto-populated, used by /analytics/schema)
CREATE TABLE beacon_meta (
    product_id      TEXT NOT NULL,
    event_type      TEXT NOT NULL,
    first_seen      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen       TIMESTAMPTZ NOT NULL DEFAULT now(),
    count           BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (product_id, event_type)
);
```

**Event time vs. ingest time.** `beacon_events` records two timestamps, and they are not interchangeable:

- **`timestamp`** — when the event *happened*, from the originating clock. For server-side `request` events this is server `now()`. For client-batched events it is the client-supplied `timestamp` (§7), which reflects the device clock and may be skewed or, for events queued offline on mobile, hours-to-days behind ingest.
- **`received_at`** — when the server *stored* the event. Always server `now()` at insert, never client-supplied.

Query semantics: time-series, funnels, and "when did users do X" group on `timestamp`. Pipeline-health and ingest-lag questions ("are events arriving late?", "did we drop a window?") use `received_at`, or the delta `received_at - timestamp`. Because client clocks are untrusted, never use `timestamp` for security or ordering guarantees where `received_at` is the honest signal. The default-`now()` on `timestamp` exists only so server-side events that omit it still get a sane value; client batches always supply it.

### 4.2 Migrations

Migrations are plain SQL files in `packages/beacon/src/storage/migrations/`, named with zero-padded sequential numbers:

```
001_initial_schema.sql
002_add_meta_table.sql
```

A `beacon_migrations` table tracks which migrations have been applied:

```sql
CREATE TABLE IF NOT EXISTS beacon_migrations (
    id          SERIAL PRIMARY KEY,
    filename    TEXT NOT NULL UNIQUE,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

The `bun run migrate` command scans the migrations directory, compares against `beacon_migrations`, and applies any unapplied files in order within a transaction.

### 4.3 Data Retention

| Config Key | Default | Description |
|---|---|---|
| `retentionDays` | `365` | Events older than this are eligible for deletion |
| `pruneInterval` | `86400000` (24h) | How often the pruning job runs |

A background timer runs every `pruneInterval` ms and deletes events older than `retentionDays` in batches of 10,000 rows to avoid long-running transactions. The `beacon_meta` table is not pruned — it serves as a lightweight historical record.

Pruning is opt-in. If `retentionDays` is set to `0`, no pruning occurs.

### 4.4 Meta Table Updates

The `beacon_meta` table is updated on each buffer flush. For each distinct `(product_id, event_type)` pair in the batch, an `INSERT ... ON CONFLICT DO UPDATE` increments the count and updates `last_seen`. This provides a cheap introspection layer for the schema endpoint without scanning the events table.

---

## 5. Query API

### 5.1 Authentication

All query API endpoints require authentication. The `isAdmin(c)` callback provided at initialization gates access. If it returns `false`, the endpoint returns `403`.

No API key system in v1. Authentication is delegated to the host app's existing auth middleware, which must run before Beacon's API routes.

### 5.2 Rate Limiting

Query API endpoints are rate limited per authenticated user:

| Config Key | Default | Description |
|---|---|---|
| `queryRateLimit` | `60` | Max requests per minute per user |

Implemented via a simple in-memory sliding window counter keyed by user ID. Returns `429` with `Retry-After` header when exceeded.

### 5.3 Common Query Parameters

These parameters are accepted by all query endpoints (except `/schema`):

| Parameter | Type | Default | Description |
|---|---|---|---|
| `product_id` | `string` | all products | Filter to a specific product |
| `after` | `ISO 8601 string` | 30 days ago | Start of time range (inclusive) |
| `before` | `ISO 8601 string` | now | End of time range (exclusive) |
| `platform` | `string` | all | Filter by platform: `web`, `ios`, `android` |
| `user_id` | `string` | all | Filter to a specific user |

### 5.4 Endpoints

#### `GET /analytics/schema`

No query parameters. Returns the full data model for agent introspection.

**Response:**

```json
{
    "products": ["clipcast", "divine-ruin", "simplyhuman"],
    "event_types": [
        {
            "product_id": "clipcast",
            "event_type": "request",
            "first_seen": "2026-03-01T00:00:00Z",
            "last_seen": "2026-04-04T12:00:00Z",
            "count": 148230
        }
    ],
    "platforms": ["web", "ios", "android"],
    "dimensions": ["product_id", "event_type", "platform", "user_id", "visitor_token"],
    "property_keys": {
        "clipcast": {
            "clip_created": ["clipId", "duration"],
            "request": ["path", "method", "status"]
        }
    },
    "time_range": {
        "earliest": "2026-03-01T00:00:00Z",
        "latest": "2026-04-04T12:00:00Z"
    },
    "endpoints": {
        "events": { "method": "GET", "path": "/analytics/events", "description": "Filtered event stream with pagination" },
        "aggregate": { "method": "GET", "path": "/analytics/aggregate", "description": "Counts and uniques grouped by dimension" },
        "funnel": { "method": "GET", "path": "/analytics/funnel", "description": "Conversion rates through event sequences" },
        "attribution": { "method": "GET", "path": "/analytics/attribution", "description": "Campaign and source performance" }
    }
}
```

The `property_keys` field is derived from a periodic scan of `DISTINCT` keys in the `properties` JSONB column, cached in memory and refreshed every 10 minutes. This avoids full-table scans on every schema request.

#### `GET /analytics/events`

Returns a paginated event stream.

**Additional parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `event_type` | `string` | all | Filter by event type |
| `limit` | `integer` | `100` | Max events returned (max `1000`) |
| `cursor` | `string` | none | Opaque pagination cursor (base64-encoded `event_id`) |

**Response:**

```json
{
    "events": [
        {
            "event_id": "550e8400-e29b-41d4-a716-446655440000",
            "product_id": "clipcast",
            "timestamp": "2026-04-04T10:30:00Z",
            "event_type": "clip_created",
            "user_id": "user_abc",
            "visitor_token": null,
            "platform": "web",
            "properties": { "clipId": "clip_123", "duration": 45 },
            "context": { "ip_hash": "a1b2c3", "user_agent": "Mozilla/5.0...", "referrer": "https://google.com" },
            "attribution": { "utm_source": "google", "utm_medium": "cpc" }
        }
    ],
    "cursor": "eyJpZCI6IjU1MGU4NDAw...",
    "has_more": true
}
```

Cursor-based pagination using `event_id`. Events are returned in reverse chronological order (newest first).

#### `GET /analytics/aggregate`

**Additional parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `event_type` | `string` | all | Filter by event type |
| `metric` | `string` | `count` | `count`, `unique_users`, `unique_visitors` |
| `group_by` | `string` | none | Dimension to group by (see §5.3 common dims + `day`, `hour`, `week`, `month`) |

**Response (ungrouped):**

```json
{
    "metric": "count",
    "value": 14823,
    "filters": { "product_id": "clipcast", "after": "2026-03-01T00:00:00Z" }
}
```

**Response (grouped):**

```json
{
    "metric": "unique_users",
    "group_by": "day",
    "groups": [
        { "key": "2026-04-01", "value": 342 },
        { "key": "2026-04-02", "value": 401 },
        { "key": "2026-04-03", "value": 389 }
    ],
    "filters": { "product_id": "clipcast", "after": "2026-04-01T00:00:00Z" }
}
```

Time-based groupings (`day`, `hour`, `week`, `month`) use `date_trunc` in Postgres. Dimension groupings return the top 100 groups by value, descending.

#### `GET /analytics/funnel`

**Additional parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `steps` | `string` | yes | Comma-separated event types in order (e.g., `request,signup,clip_created`) |
| `window` | `integer` | no | Max seconds between first and last step. Default `86400` (24h). |

**Response:**

```json
{
    "steps": [
        { "event_type": "request", "count": 10000, "conversion_rate": 1.0 },
        { "event_type": "signup", "count": 1200, "conversion_rate": 0.12 },
        { "event_type": "clip_created", "count": 450, "conversion_rate": 0.375 }
    ],
    "overall_conversion": 0.045,
    "window_seconds": 86400,
    "filters": { "product_id": "clipcast", "after": "2026-03-01T00:00:00Z" }
}
```

Funnel logic: for each user (or visitor_token if unauthenticated), check if they completed step N before step N+1 within the time window. Users who didn't complete a step are excluded from subsequent steps. `conversion_rate` is relative to the previous step (except step 1, which is always `1.0`). `overall_conversion` is last step count / first step count.

#### `GET /analytics/attribution`

**Additional parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `group_by` | `string` | `utm_source` | Attribution dimension: `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`, or `channel` |
| `conversion_event` | `string` | `signup` | Event type that counts as a conversion |

**Response:**

```json
{
    "group_by": "utm_source",
    "conversion_event": "signup",
    "groups": [
        { "key": "google", "clicks": 5000, "conversions": 600, "conversion_rate": 0.12 },
        { "key": "twitter", "clicks": 3000, "conversions": 180, "conversion_rate": 0.06 },
        { "key": "direct", "clicks": 8000, "conversions": 400, "conversion_rate": 0.05 }
    ],
    "filters": { "product_id": "clipcast", "after": "2026-03-01T00:00:00Z" }
}
```

`channel` grouping is a derived dimension that buckets sources into categories: `paid`, `organic`, `social`, `referral`, `direct`, `email`. Mapping is configurable via `channelMapping` config.

### 5.5 Error Format

All error responses follow this shape:

```json
{
    "error": {
        "code": "INVALID_PARAMETER",
        "message": "Parameter 'group_by' must be one of: product_id, event_type, platform, user_id, day, hour, week, month",
        "parameter": "group_by"
    }
}
```

Error codes: `INVALID_PARAMETER`, `MISSING_PARAMETER`, `RATE_LIMITED`, `UNAUTHORIZED`, `INTERNAL_ERROR`.

HTTP status codes: `400` for invalid/missing params, `403` for unauthorized, `429` for rate limited, `500` for internal errors.

---

## 6. Custom Events

### 6.1 Server-Side Helper

```typescript
beacon.track(c: Context, eventType: string, properties?: Record<string, unknown>): void
```

- Reads `user_id` and `visitor_token` from the Hono context (set by middleware)
- Creates an event with the given type and properties
- Pushes to the same in-memory buffer as middleware events
- Does not block — returns immediately

### 6.2 Client-Side Batch Endpoint

```
POST /analytics/events
Content-Type: application/json
```

**Request body:**

```json
{
    "events": [
        {
            "event_type": "screen_view",
            "properties": { "screen": "HomeScreen" },
            "timestamp": "2026-04-04T10:30:00Z"
        },
        {
            "event_type": "button_tap",
            "properties": { "button": "create_clip" },
            "timestamp": "2026-04-04T10:30:05Z"
        }
    ]
}
```

**Constraints:**

- Max 100 events per request
- Each event must have an `event_type` (string, max 100 chars)
- `properties` is optional, max 10KB serialized JSON per event
- `timestamp` (event time) is optional; when omitted it defaults to `received_at`. `received_at` is always set server-side at ingest and is never accepted from the client (see §4.1, Event time vs. ingest time)
- `product_id` and `platform` are inferred from the `X-App-Context` header or the host app's config
- `user_id` is inferred from auth context if present

Returns `202 Accepted` with `{ "accepted": <count> }`. Events are buffered, not written synchronously.

Rate limited: 10 requests per minute per IP (unauthenticated) or per user ID (authenticated).

---

## 7. URL Shortener

### 7.1 Code Generation

- Character set: `[a-zA-Z0-9]` (62 characters)
- Length: 6 characters (62^6 ≈ 56.8 billion combinations)
- Generated via `crypto.randomBytes(6)` mapped to the character set
- Collision check: `INSERT ... ON CONFLICT DO NOTHING`, retry up to 3 times with new codes
- No sequential or predictable codes

### 7.2 Routes

#### `POST /short` — Create a short link

Protected by the same `isAdmin` check as the query API.

**Request body:**

```json
{
    "destination": "https://clipcast.com/signup",
    "product_id": "clipcast",
    "campaign": {
        "source": "twitter",
        "medium": "social",
        "campaign": "launch-2026"
    },
    "expires_at": "2026-12-31T23:59:59Z"
}
```

**Response:**

```json
{
    "code": "xK4mQ2",
    "destination": "https://clipcast.com/signup",
    "url": "https://pi.ink/xK4mQ2",
    "created_at": "2026-04-04T12:00:00Z",
    "expires_at": "2026-12-31T23:59:59Z"
}
```

The short URL base domain is configurable via `shortDomain` config (e.g., `https://pi.ink`).

**Rate limit:** 100 link creations per hour per admin user.

#### `GET /:code` — Redirect

1. Look up code in `beacon_short_links`
2. If not found or expired: return `404` with a simple "Link not found" page
3. Increment `click_count` (fire-and-forget, non-blocking)
4. Log a `short_link_click` event to the event buffer with:
   - `product_id` from the short link record
   - `properties`: `{ code, destination }`
   - `attribution`: campaign data from the short link record, merged with any URL params on the short link request
   - Standard request metadata (IP, user-agent, referrer)
5. Return `302` redirect to `destination`

The redirect must be fast. The DB lookup should use the primary key index. Event logging and click count increment are non-blocking.

### 7.3 Caching

Short link lookups are cached in memory using an LRU cache:

| Config Key | Default | Description |
|---|---|---|
| `shortLinkCacheSize` | `10000` | Max entries in the LRU cache |
| `shortLinkCacheTTL` | `300000` (5 min) | Cache entry TTL |

Expired links are checked against the cache's stored `expires_at` value. Cache is invalidated on link update or deletion.

---

## 8. Client SDK (`beacon-client`)

### 8.1 Core Module

Platform-agnostic TypeScript. No runtime-specific APIs.

```typescript
class BeaconClient {
    constructor(config: BeaconClientConfig);
    track(eventType: string, properties?: Record<string, unknown>): void;
    screenView(screenName: string): void;
    flush(): Promise<void>;
    reset(): void;
    getContextHeaders(): Record<string, string>;
}
```

**Event queue:** Plain array, max `500` events in memory. When full, oldest events are dropped.

**Optional durable queue (mobile):** `BeaconClientConfig` accepts an optional `storage` adapter (`load()` / `save()` / `clear()`). When provided, the queue is persisted so pending events survive the OS killing a backgrounded app; when omitted, the queue is purely in-memory. The adapter stores only undelivered event payloads — never identifiers or tracking state — and is cleared on successful flush, so it is consistent with the no-client-side-storage constraint. The host app supplies the adapter; the SDK adds no storage dependency. See `phases/PHASE_8_CLIENT_SDK.md` §8.1.

**Flush behavior:**
- Timer fires every `flushInterval` ms (default `30000`)
- Flush also triggered when queue reaches `maxBatchSize` (default `50`)
- `flush()` can be called manually
- Flush sends `POST` to the configured endpoint with the batch
- On network failure: batch is re-queued (once). If the retry also fails, events are dropped.
- On `4xx` response: events are dropped (client error, don't retry).
- On `5xx` response: batch is re-queued for one retry.

**`reset()`:** Clears the event queue and cancels pending timers. Called on app foreground to start a fresh session.

### 8.2 Context Headers

`getContextHeaders()` returns:

```json
{
    "X-App-Context": "{\"appVersion\":\"1.2.0\",\"platform\":\"ios\",\"os\":\"iOS 18.2\",\"device\":\"iPhone 16\",\"screen\":\"393x852\"}"
}
```

The host app attaches these headers to every outgoing API request. The server middleware parses them and includes them in the event's `context` JSONB.

### 8.3 React Native Wrapper

```typescript
function useBeaconLifecycle(client: BeaconClient): void;
```

- Listens to `AppState` changes
- On `active → background`: calls `client.flush()`
- On `background → active`: calls `client.reset()`
- Populates device context automatically via React Native's `Platform`, `Dimensions`, and device info APIs
- Cleans up listener on unmount

### 8.4 Web Wrapper (Optional)

```typescript
function useBeaconWeb(client: BeaconClient): void;
```

- Listens to `visibilitychange`: flushes on `hidden`
- Listens to `beforeunload`: flushes via `navigator.sendBeacon()` for reliable delivery
- No cookies, no localStorage, no sessionStorage

---

## 9. Admin Dashboard

### 9.1 Implementation

- Server-rendered HTML via Hono's `c.html()` — no build step, no React, no client-side JS framework
- Minimal inline JavaScript for interactive elements (date range picker, product selector, chart rendering)
- Charts rendered via a lightweight library inlined in the page (e.g., Chart.js from CDN, or simple SVG generation)
- Protected by `isAdmin(c)` — returns `403` if false

### 9.2 Views

**Overview (default):**
- Total events, unique users, unique visitors for the selected time range
- Sparkline or bar chart of daily event volume
- Product selector dropdown (filters all widgets)
- Date range selector (preset: today, 7d, 30d, 90d; custom range)

**Top Pages:**
- Table of top 20 paths by event count
- Columns: path, views, unique users, avg response time

**Attribution:**
- Table grouped by `utm_source` (configurable)
- Columns: source, clicks, conversions, conversion rate

**Funnel:**
- Configurable step selector (dropdown of known event types)
- Visual funnel with counts and drop-off percentages

All views consume the query API endpoints via `fetch()` from inline JavaScript.

### 9.3 Dashboard Route

Mounted at `{basePath}/dashboard` (default `/analytics/dashboard`). Static assets (CSS, JS if any) are inlined in the HTML response to avoid additional route configuration.

---

## 10. Configuration Reference

```typescript
interface BeaconConfig {
    // Required
    productId: string;
    postgres: {
        connectionString: string;
        maxConnections?: number;        // default: 10
    };

    // Auth callbacks
    getUserId?: (c: Context) => string | null;      // default: () => null
    isAdmin?: (c: Context) => boolean;              // default: () => false

    // Routing
    basePath?: string;                              // default: '/analytics'

    // Middleware
    excludePaths?: string[];                        // default: []
    hashIPs?: boolean;                              // default: true

    // Event buffer
    flushInterval?: number;                         // default: 5000 ms
    maxBatchSize?: number;                          // default: 100
    maxBufferSize?: number;                         // default: 10000

    // Visitor tokens
    visitorTokenTTL?: number;                       // default: 1800000 (30 min)
    maxVisitorTokens?: number;                      // default: 50000

    // Data retention
    retentionDays?: number;                         // default: 365, 0 = no pruning
    pruneInterval?: number;                         // default: 86400000 (24h)

    // Query API
    queryRateLimit?: number;                        // default: 60 requests/min/user

    // URL shortener
    shortDomain?: string;                           // e.g., 'https://pi.ink'
    shortLinkCacheSize?: number;                    // default: 10000
    shortLinkCacheTTL?: number;                     // default: 300000 (5 min)

    // Attribution
    channelMapping?: Record<string, string[]>;      // e.g., { paid: ['google', 'bing'], social: ['twitter', 'linkedin'] }
}
```

---

## 11. Testing Strategy

### 11.1 Unit Tests

No database required. Mock the Postgres adapter.

| Area | What to test |
|---|---|
| Event buffer | Flush triggers, backpressure, retry logic, batch sizing |
| Visitor token | Generation format, TTL expiry, eviction, association |
| Attribution capture | UTM parsing, click ID extraction, custom param prefix, first-touch precedence |
| Query parameter validation | All endpoints: valid/invalid params, defaults, error format |
| Short link code generation | Format, length, character set, collision retry |
| Client SDK core | Event queue limits, flush timing, retry/drop behavior, reset |

### 11.2 Integration Tests

Require a test Postgres instance (use `docker run postgres` or a test container).

| Area | What to test |
|---|---|
| Middleware → buffer → Postgres | Full write path: request comes in, event lands in the database |
| Visitor association | Token-based event trail gets linked to a user ID |
| Query API responses | Each endpoint returns correct data for known test events |
| Funnel logic | Multi-step conversion calculation with edge cases (out-of-order, expired window) |
| Migration runner | Applies cleanly to an empty database, is idempotent |
| Short link redirect | Create → click → event logged → redirect returned |
| Data retention pruning | Old events deleted, recent events preserved |

### 11.3 Test Utilities

Beacon exports a test helper:

```typescript
import { createTestBeacon } from '@pi-innovations/beacon/test';

const { beacon, db, cleanup } = await createTestBeacon({
    postgres: { connectionString: process.env.TEST_DATABASE_URL },
});

// ... run tests ...

await cleanup(); // drops test tables, closes connections
```

---

## 12. Non-Requirements (Out of Scope for v1)

- **No real-time streaming.** All queries are request/response. No WebSocket push or SSE.
- **No user-facing analytics.** The dashboard and API are admin-only. No end-user analytics views.
- **No data export.** No CSV/JSON export endpoints. Query the API or the database directly.
- **No multi-tenancy.** Beacon serves PI Innovations products only. No tenant isolation or billing.
- **No MCP server.** The query API is designed to be MCP-compatible, but the actual MCP server wrapper is a future enhancement.
- **No A/B testing.** Beacon is observational only. No experiment assignment or variant tracking.
- **No client-side session reconstruction.** Pre-auth visitor trails are best-effort. No sophisticated session stitching.
- **No mobile install attribution.** SKAdNetwork / Google install referrer integration is out of scope.
