# Phase 4: Custom Events

## Relevant Sections

- `REQUIREMENTS.md` → §6 Custom Events (§6.1 Server-Side Helper, §6.2 Client-Side Batch Endpoint)
- `REQUIREMENTS.md` → §1.2 Event Buffer (shared buffer for custom events)
- `BEACON_OVERVIEW.md` → Data Collection → Custom Product Events, Mobile — Client-Side Events

## Goal

Add two ways to record custom product events beyond automatic request logging: a server-side `track()` helper for route handlers, and a `POST /analytics/events` batch endpoint for the mobile client SDK. Both feed into the same event buffer from Phase 2.

---

## Milestones

### 4.1 — Server-Side Track Helper

**Deliverables:**

- `beacon.track(c, eventType, properties?)` per `REQUIREMENTS.md` §6.1:
  - Reads `user_id` from `getUserId(c)` and `visitor_token` from context (set by middleware)
  - Creates an event with the given `event_type` and `properties`
  - Sets `product_id` from Beacon config
  - Sets `platform` from `X-App-Context` header if present, otherwise `'web'`
  - Populates `context` with request metadata (IP hash, user-agent, referrer) from the current request
  - Pushes to the existing `EventBuffer` — does not block, returns `void`
- Event type validation: non-empty string, max 100 characters. Throws if invalid.

**Tests (unit):**

- Event is pushed to buffer with correct fields
- `user_id` and `visitor_token` are read from context
- Platform is inferred from `X-App-Context` when present
- Invalid event type (empty, too long) throws
- `track()` returns immediately (does not await anything)

**Tests (integration):**

- Full round-trip: call `track()` in a route handler → flush → event appears in Postgres with correct `event_type` and `properties`

### 4.2 — Client Batch Ingest Endpoint

Build the `POST /analytics/events` endpoint that the mobile client SDK will call.

**Deliverables:**

- `packages/beacon/src/api/ingest.ts` — Hono route handler for `POST /analytics/events`:
  - Accepts JSON body per `REQUIREMENTS.md` §6.2
  - Validates constraints:
    - Max 100 events per request (return `400` if exceeded)
    - Each event must have `event_type` (string, max 100 chars)
    - `properties` is optional, max 10KB serialized per event
    - `timestamp` is optional, defaults to server receipt time
  - Infers `product_id` from Beacon config
  - Infers `platform` from `X-App-Context` header
  - Infers `user_id` from auth context if present
  - Pushes all valid events to the `EventBuffer`
  - Returns `202 Accepted` with `{ "accepted": <count> }`
  - Invalid individual events within a batch are skipped (not rejected) — `accepted` count reflects only valid events
- Rate limiting: 10 requests per minute per IP (unauthenticated) or per user ID (authenticated)
  - In-memory sliding window counter
  - Returns `429` with `Retry-After` header when exceeded
- Error responses follow the format from `REQUIREMENTS.md` §5.5

**Tests (unit):**

- Valid batch returns `202` with correct accepted count
- Batch exceeding 100 events returns `400`
- Events with missing `event_type` are skipped
- Events with oversized `properties` are skipped
- `timestamp` defaults to server time when omitted
- `platform` and `user_id` inferred correctly

**Tests (integration):**

- Posted events appear in Postgres after buffer flush
- Rate limiting returns `429` after threshold

### 4.3 — Mount Ingest on Beacon Router

Wire the ingest endpoint into the Beacon API router.

**Deliverables:**

- Update `beacon.router()` to include the ingest route at `POST {basePath}/events`
- The ingest endpoint does NOT require admin auth (it's called by client SDKs) — but it does require the rate limit from §4.2
- If the host app has auth middleware, `user_id` is picked up automatically; if not, the endpoint still works for anonymous event ingestion

**Tests (integration):**

- Ingest endpoint is reachable at the configured base path
- Works both with and without authenticated context

---

## Exit Criteria

- Route handlers can call `beacon.track()` to log custom product events
- Mobile/web clients can POST batches of events to `/analytics/events`
- Both paths feed the same event buffer and appear in the same Postgres tables
- Rate limiting protects the ingest endpoint
- Validation rejects bad input without crashing
- All unit and integration tests pass
- `bun test` at root passes (no regressions from Phases 1–3)
