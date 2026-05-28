# Phase 2: Middleware

## Relevant Sections

- `REQUIREMENTS.md` → §1.1 Request Logging, §1.2 Event Buffer, §1.3 Failure Isolation
- `REQUIREMENTS.md` → §10 Configuration Reference (`flushInterval`, `maxBatchSize`, `maxBufferSize`, `excludePaths`, `hashIPs`)
- `CLAUDE.md` → Key Architecture Decisions → Server Middleware

## Goal

Build the core Hono middleware that logs every request and the event buffer that batches writes to Postgres. After this phase, mounting Beacon in a Hono app will silently capture all traffic as `request` events in the database.

---

## Milestones

### 2.1 — Event Buffer

Build the in-memory event buffer and flush pipeline before the middleware, so it's ready to receive events.

**Deliverables:**

- `packages/beacon/src/events/buffer.ts` — `EventBuffer` class implementing:
  - `push(event)` — adds an event to the buffer; drops silently if at `maxBufferSize`
  - `flush()` — writes one batch (up to `maxBatchSize`) to Postgres via bulk `INSERT` using `UNNEST` arrays
  - `start()` — begins the flush timer at `flushInterval`
  - `stop()` — stops the timer, flushes remaining events with a 5-second timeout
  - `stats()` — returns `{ buffered, flushed, dropped, retryFailures }`
- Retry logic per `REQUIREMENTS.md` §1.2: on write failure, re-queue batch to front of buffer (max 3 retries per batch, then drop)
- Flush triggered by timer AND by buffer reaching `maxBatchSize`
- Dropped event counter tracks backpressure drops and retry-exhaustion drops separately
- `beacon_meta` table updated on each flush per `REQUIREMENTS.md` §4.4 — `INSERT ... ON CONFLICT DO UPDATE` for each distinct `(product_id, event_type)` pair in the batch

**Tests (unit, mocked Postgres):**

- Buffer respects `maxBufferSize`, drops events when full
- Flush writes correct number of events
- Retry re-queues on failure, drops after 3 attempts
- Stats counters are accurate
- Flush on `maxBatchSize` trigger

**Tests (integration):**

- Events flushed to Postgres are queryable
- `beacon_meta` rows created and updated correctly

### 2.2 — Request Logging Middleware

Build the Hono middleware that captures request metadata and pushes events to the buffer.

**Deliverables:**

- `packages/beacon/src/middleware/requestLogger.ts` — Hono middleware function that:
  - Skips paths matching `excludePaths` prefixes
  - Captures all fields listed in `REQUIREMENTS.md` §1.1
  - Hashes IP via SHA-256 when `hashIPs` is true (default)
  - Calls the `getUserId(c)` callback to check for an authenticated user
  - Records `response_time_ms` by wrapping the downstream handler
  - Pushes a `request` event to the `EventBuffer`
  - Never blocks the response — event push is synchronous (in-memory), actual write is async via buffer
  - Parses `X-App-Context` header if present, stores in `context` JSONB (malformed JSON silently ignored)
- Event `platform` defaults to `'web'`; overridden to value from `X-App-Context` if present

**Tests (unit):**

- Middleware captures correct fields from a mock Hono context
- Excluded paths are skipped
- IP hashing produces consistent SHA-256 output
- Malformed `X-App-Context` header doesn't throw
- Response timing is captured (before/after handler)

### 2.3 — Beacon Factory & Shutdown

Wire the buffer and middleware together via the main `createBeacon()` entry point.

**Deliverables:**

- `packages/beacon/src/index.ts` — exports `createBeacon(config)` returning a `Beacon` object with:
  - `middleware()` — returns the Hono middleware from §2.2
  - `stats()` — returns buffer stats
  - `flush()` — manual flush
  - `shutdown()` — stops buffer, flushes remaining, closes Postgres connection
- Config validation: `productId` and `postgres.connectionString` are required, throw on missing
- Buffer is created and started internally on `createBeacon()`
- Postgres connection is created via the Phase 1 `createDb()` layer

**Tests (integration):**

- Full round-trip: create Beacon → mount middleware on a test Hono app → send HTTP request → verify event appears in Postgres
- `shutdown()` flushes remaining events before closing
- Config validation throws on missing required fields

### 2.4 — Failure Isolation Verification

Verify the behavior described in `REQUIREMENTS.md` §1.3.

**Tests (integration):**

- Beacon initializes without throwing when Postgres is unreachable
- Middleware still captures events to the in-memory buffer when Postgres is down
- Events drain to Postgres once the connection recovers
- Host app continues serving responses normally regardless of Beacon's Postgres state

---

## Exit Criteria

- Mounting `beacon.middleware()` on a Hono app captures all requests as events in Postgres
- Event buffer batches writes efficiently and handles failures gracefully
- `beacon.stats()` reports accurate counters
- `beacon.shutdown()` cleanly drains and disconnects
- Host app is never blocked or crashed by Beacon
- All unit and integration tests pass
- `bun test` at root still passes (no Phase 1 regressions)
