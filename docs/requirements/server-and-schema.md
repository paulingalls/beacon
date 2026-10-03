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

Migrations are plain SQL files in `apps/server/src/storage/migrations/`, named with zero-padded sequential numbers:

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
| `retentionDays` | unset (disabled) | Positive days enable event deletion; 0 means disabled, no pruning |
| `pruneInterval` | `86400000` (24h) | How often the pruning job runs |

Pruning is off unless set: omitted or `0` means no pruning. Positive finite days enable
an unref'd background timer every `pruneInterval` ms (default 86400000, 24 hours).
Each non-overlapping run uses one cutoff and deletes events strictly before it,
measured from event `timestamp`, in batches of at most 10,000 rows. Cutoff equality
is retained. `beacon_meta`, `beacon_short_links` and `beacon_erasures` remain unchanged.

`retentionDays` must be a finite nonnegative number producing a representable Date
cutoff. `pruneInterval` must be an integer from 1 through 2147483647 milliseconds.
Invalid configuration throws before resources are created. Each run also validates
its current cutoff; runtime errors warn and allow retry on the next interval.
`shutdown()` cancels future scheduling, awaits in-flight SQL, starts no further
batch after stop, then closes the database.

### 4.4 Meta Table Updates

The `beacon_meta` table is updated on each buffer flush. For each distinct `(product_id, event_type)` pair in the batch, an `INSERT ... ON CONFLICT DO UPDATE` increments the count and updates `last_seen`. This provides a cheap introspection layer for the schema endpoint without scanning the events table.

---

