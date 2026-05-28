# Phase 6: URL Shortener

## Relevant Sections

- `REQUIREMENTS.md` → §7 URL Shortener (§7.1 Code Generation, §7.2 Routes, §7.3 Caching)
- `REQUIREMENTS.md` → §3.3 Short Link Attribution
- `REQUIREMENTS.md` → §4.1 Tables (`beacon_short_links`)
- `REQUIREMENTS.md` → §10 Configuration Reference (`shortDomain`, `shortLinkCacheSize`, `shortLinkCacheTTL`)
- `BEACON_OVERVIEW.md` → URL Shortener

## Goal

Build a URL shortener that lives on the same Postgres instance, logs every redirect as an analytics event, and bakes campaign attribution into the link record rather than destination URL params. After this phase, short links can be created programmatically and used across all products for trackable campaign distribution.

---

## Milestones

### 6.1 — Code Generator

**Deliverables:**

- `packages/beacon/src/shortener/codeGen.ts` — `generateCode()` function:
  - Character set: `[a-zA-Z0-9]` (62 chars)
  - Length: 6 characters
  - Generated via `crypto.randomBytes(6)` mapped to the character set
  - Returns a string — no database interaction in this function

**Tests (unit):**

- Output is always 6 characters
- Output contains only `[a-zA-Z0-9]`
- Multiple calls produce different codes (statistical check over 100 runs)

### 6.2 — Short Link Storage

**Deliverables:**

- `packages/beacon/src/shortener/store.ts` — short link data access:
  - `createShortLink(destination, productId, campaign?, expiresAt?)`:
    - Generates code via `generateCode()`
    - `INSERT ... ON CONFLICT DO NOTHING` — if collision, retry with new code up to 3 times
    - After 3 collisions, throw an error
    - Returns `{ code, destination, url, created_at, expires_at }`
    - `url` is constructed using `shortDomain` config
  - `getShortLink(code)`:
    - Looks up by primary key
    - Returns the record or `null`
    - Checks `expires_at` — returns `null` if expired
  - `incrementClickCount(code)`:
    - `UPDATE beacon_short_links SET click_count = click_count + 1 WHERE code = $1`
    - Fire-and-forget (non-blocking)

**Tests (integration):**

- Create and retrieve a short link
- Expired links return `null`
- Collision retry works (can be tested by inserting a known code first)
- Click count increments correctly

### 6.3 — LRU Cache

**Deliverables:**

- `packages/beacon/src/shortener/cache.ts` — `ShortLinkCache` class:
  - LRU eviction with `shortLinkCacheSize` max entries (default 10000)
  - TTL per entry: `shortLinkCacheTTL` (default 5 min)
  - `get(code)` → cached record or `null` (checks TTL, evicts if expired)
  - `set(code, record)` → caches the record
  - `invalidate(code)` → removes from cache
  - Wraps the store's `getShortLink()` — check cache first, fall through to DB on miss, populate cache on hit

**Tests (unit):**

- Cache hit avoids DB lookup
- Cache miss falls through to DB, populates cache
- TTL expiry causes re-fetch
- LRU eviction when at capacity
- `invalidate()` removes entry

### 6.4 — Redirect Route

**Deliverables:**

- `packages/beacon/src/shortener/redirect.ts` — Hono route handler for `GET /:code`:
  1. Look up code via the cache layer (§6.3)
  2. If not found or expired: return `404` with a simple HTML "Link not found" page
  3. Call `incrementClickCount(code)` (fire-and-forget)
  4. Push a `short_link_click` event to the event buffer with:
     - `product_id` from the short link record
     - `event_type`: `short_link_click`
     - `properties`: `{ code, destination }`
     - `attribution`: campaign data from the short link record merged with any request URL params per `REQUIREMENTS.md` §3.3 (short link campaign data takes precedence)
     - Standard request metadata (IP hash, user-agent, referrer)
  5. Return `302` redirect to `destination`
- The redirect must be fast — cache lookup + fire-and-forget writes, no blocking

**Tests (integration):**

- Valid code returns `302` with correct `Location` header
- `short_link_click` event appears in Postgres after flush
- Expired code returns `404`
- Unknown code returns `404`
- Click count is incremented
- Campaign attribution from the short link record is present on the event

### 6.5 — Create Short Link Route

**Deliverables:**

- `packages/beacon/src/shortener/create.ts` — Hono route handler for `POST /short`:
  - Protected by admin auth middleware (same as query API)
  - Accepts JSON body per `REQUIREMENTS.md` §7.2
  - Validates: `destination` is required and must be a valid URL, `product_id` is required
  - Rate limit: 100 creations per hour per admin user (separate from query rate limit)
  - Returns `201` with the short link object
  - Error responses per `REQUIREMENTS.md` §5.5

**Tests (integration):**

- Create returns `201` with code, destination, url, timestamps
- Missing destination returns `400`
- Invalid URL returns `400`
- Rate limit returns `429` after threshold
- Non-admin returns `403`

### 6.6 — Mount Shortener on Beacon

**Deliverables:**

- `beacon.shortener()` returns a Hono router with:
  - `POST /short` (create, admin-only)
  - `GET /:code` (redirect, public)
- Exposed as a separate router from `beacon.router()` because the shortener is typically mounted on a different domain/app
- `beacon.createShortLink(opts)` also exposed as a programmatic API (for creating links from code without HTTP)

**Tests (integration):**

- Full round-trip: create via API → click short link → verify redirect + analytics event in DB
- Full round-trip: create via `beacon.createShortLink()` → click → verify

---

## Exit Criteria

- Short links can be created via API and programmatically
- Redirects are fast (cache-first) and log analytics events
- Campaign attribution is baked into link records and flows to events
- LRU cache with TTL reduces database load for hot links
- All unit and integration tests pass
- `bun test` at root passes (no regressions from Phases 1–5)
