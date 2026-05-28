# Phase 5: Query API

## Relevant Sections

- `REQUIREMENTS.md` → §5 Query API (§5.1 Authentication, §5.2 Rate Limiting, §5.3 Common Query Parameters, §5.4 Endpoints, §5.5 Error Format)
- `REQUIREMENTS.md` → §4.4 Meta Table Updates (used by schema endpoint)
- `REQUIREMENTS.md` → §10 Configuration Reference (`queryRateLimit`, `channelMapping`)
- `BEACON_OVERVIEW.md` → Query API, Agent Integration

## Goal

Build the five query API endpoints that power both the admin dashboard and agent-driven analytics. After this phase, an authenticated admin (or AI agent) can query events, run aggregations, analyze funnels, and inspect attribution data across all PI Innovations products.

---

## Milestones

### 5.1 — Query Infrastructure

Build the shared components used by all query endpoints.

**Deliverables:**

- `packages/beacon/src/api/auth.ts` — Hono middleware that:
  - Calls `isAdmin(c)` — returns `403` with error format from `REQUIREMENTS.md` §5.5 if false
  - Sets admin user identity on context for rate limiting
- `packages/beacon/src/api/rateLimit.ts` — query rate limiter:
  - In-memory sliding window counter keyed by user ID (from `getUserId(c)`)
  - `queryRateLimit` requests per minute (default 60)
  - Returns `429` with `Retry-After` header when exceeded
  - Error response per `REQUIREMENTS.md` §5.5
- `packages/beacon/src/api/params.ts` — common query parameter parser:
  - Parses and validates all parameters from `REQUIREMENTS.md` §5.3
  - `product_id`: optional string
  - `after`: optional ISO 8601, defaults to 30 days ago
  - `before`: optional ISO 8601, defaults to now
  - `platform`: optional, must be one of `web`, `ios`, `android`
  - `user_id`: optional string
  - Returns parsed object or throws with `INVALID_PARAMETER` error
- `packages/beacon/src/api/errors.ts` — error response helpers:
  - `invalidParam(parameter, message)` → `400` response
  - `missingParam(parameter)` → `400` response
  - `unauthorized()` → `403` response
  - `rateLimited(retryAfter)` → `429` response
  - `internalError(message)` → `500` response
  - All follow the JSON shape from `REQUIREMENTS.md` §5.5

**Tests (unit):**

- Auth middleware returns `403` when `isAdmin` returns false
- Rate limiter tracks per-user counts correctly, returns `429` with header
- Common param parser validates types, applies defaults, rejects bad input
- Error helpers produce correct HTTP status and JSON shape

### 5.2 — Schema Endpoint

**Deliverables:**

- `GET {basePath}/schema` per `REQUIREMENTS.md` §5.4:
  - Reads `beacon_meta` table for products, event types, counts, time ranges
  - Reads available platforms from `SELECT DISTINCT platform FROM beacon_events`
  - Returns `property_keys` — distinct JSONB keys per `(product_id, event_type)`, cached in memory, refreshed every 10 minutes
  - Returns `endpoints` object describing available query endpoints with methods, paths, and descriptions
  - Full response shape per `REQUIREMENTS.md` §5.4
- Property keys cache: on first call and every 10 minutes, run `SELECT DISTINCT product_id, event_type, jsonb_object_keys(properties) ...` and store results in memory

**Tests (integration):**

- Schema response includes products and event types from test data
- Property keys reflect actual JSONB keys in stored events
- Time range reflects actual data bounds
- Endpoints object is complete and accurate

### 5.3 — Events Endpoint

**Deliverables:**

- `GET {basePath}/events` per `REQUIREMENTS.md` §5.4:
  - Accepts common params + `event_type`, `limit` (max 1000, default 100), `cursor`
  - Cursor is base64-encoded `event_id` for keyset pagination
  - Returns events in reverse chronological order (newest first)
  - Response includes `events` array, `cursor` (for next page), `has_more` boolean
  - Full response shape per `REQUIREMENTS.md` §5.4
- SQL uses `WHERE` clauses for all filters, `ORDER BY timestamp DESC, event_id DESC`, and cursor-based pagination via `(timestamp, event_id) < (cursor_timestamp, cursor_id)`

**Tests (integration):**

- Returns events matching filters
- Pagination: first page returns `has_more: true` with cursor, second page picks up where first left off
- `limit` is respected, capped at 1000
- Empty result returns empty array with `has_more: false`
- Invalid cursor returns `400`

### 5.4 — Aggregate Endpoint

**Deliverables:**

- `GET {basePath}/aggregate` per `REQUIREMENTS.md` §5.4:
  - Accepts common params + `event_type`, `metric` (`count`, `unique_users`, `unique_visitors`), `group_by`
  - Ungrouped: returns single `value`
  - Grouped by dimension (`product_id`, `event_type`, `platform`, `user_id`, `visitor_token`): returns top 100 groups by value descending
  - Grouped by time (`day`, `hour`, `week`, `month`): uses `date_trunc`, returns all groups in chronological order
  - `unique_users` uses `COUNT(DISTINCT user_id) WHERE user_id IS NOT NULL`
  - `unique_visitors` uses `COUNT(DISTINCT COALESCE(user_id, visitor_token))`
  - Response shapes per `REQUIREMENTS.md` §5.4

**Tests (integration):**

- Ungrouped count returns correct total
- `unique_users` excludes anonymous events
- `unique_visitors` deduplicates across user_id and visitor_token
- Time grouping returns correct buckets
- Dimension grouping returns top 100, sorted descending
- Filters are applied correctly

### 5.5 — Funnel Endpoint

**Deliverables:**

- `GET {basePath}/funnel` per `REQUIREMENTS.md` §5.4:
  - Accepts common params + `steps` (required, comma-separated event types) + `window` (max seconds, default 86400)
  - Funnel logic per `REQUIREMENTS.md` §5.4: for each user/visitor, check ordered step completion within the time window
  - `conversion_rate` is relative to previous step (step 1 is always `1.0`)
  - `overall_conversion` is last step count / first step count
  - Users/visitors who don't complete a step are excluded from subsequent steps
  - Response shape per `REQUIREMENTS.md` §5.4
- `steps` parameter validation: at least 2 steps required, max 10

**Tests (integration):**

- Simple 3-step funnel returns correct counts and conversion rates
- Window constraint: users completing steps outside the window are excluded
- Users who skip a middle step are excluded from subsequent steps
- `overall_conversion` calculated correctly
- Missing `steps` param returns `400`

### 5.6 — Attribution Endpoint

**Deliverables:**

- `GET {basePath}/attribution` per `REQUIREMENTS.md` §5.4:
  - Accepts common params + `group_by` (attribution dimension, default `utm_source`) + `conversion_event` (default `signup`)
  - Groups by the specified attribution JSONB key
  - `clicks`: count of events with the attribution key present
  - `conversions`: count of distinct users who have both the attribution key and a `conversion_event`
  - `conversion_rate`: conversions / clicks
  - `channel` grouping uses `channelMapping` config to bucket sources into categories (`paid`, `organic`, `social`, `referral`, `direct`, `email`)
  - Response shape per `REQUIREMENTS.md` §5.4

**Tests (integration):**

- Groups by `utm_source` correctly
- Conversion count and rate calculated correctly
- `channel` grouping maps sources to categories per config
- Unknown sources fall into an `other` channel bucket
- Events without attribution data are excluded from results

### 5.7 — Mount API Router

Wire all endpoints into the Beacon router.

**Deliverables:**

- Update `beacon.router()` to mount all query endpoints under the configured `basePath`:
  - `GET {basePath}/schema`
  - `GET {basePath}/events`
  - `GET {basePath}/aggregate`
  - `GET {basePath}/funnel`
  - `GET {basePath}/attribution`
- All query endpoints go through the admin auth middleware and rate limiter from §5.1
- The ingest endpoint from Phase 4 (`POST {basePath}/events`) remains on the same router but does NOT use admin auth (it has its own rate limiting)

**Tests (integration):**

- All endpoints reachable at correct paths
- Admin auth blocks non-admin users
- Rate limiter applies to query endpoints independently from ingest rate limiting

---

## Exit Criteria

- All five query endpoints return correct data for known test scenarios
- Schema endpoint provides full introspection — sufficient for an agent to discover and use the other endpoints
- Authentication and rate limiting protect all query endpoints
- Error responses are consistent and follow the defined format
- All unit and integration tests pass
- `bun test` at root passes (no regressions from Phases 1–4)
