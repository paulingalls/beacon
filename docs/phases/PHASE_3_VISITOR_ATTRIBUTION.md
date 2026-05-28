# Phase 3: Visitor Tokens & Attribution

## Relevant Sections

- `REQUIREMENTS.md` → §2 Visitor Token (§2.1 Generation, §2.2 Storage, §2.3 Propagation, §2.4 Association)
- `REQUIREMENTS.md` → §3 Attribution (§3.1 Captured Parameters, §3.2 Storage, §3.3 Short Link Attribution)
- `BEACON_OVERVIEW.md` → Data Collection → Web — Pre-Auth Visitors, Campaign Attribution

## Goal

Add pre-auth visitor tracking and campaign attribution capture to the middleware. After this phase, anonymous visitors get a trackable token propagated via URL parameters, UTM/ad platform params are captured on first hit, and the full visitor trail is associated with the user on authentication.

---

## Milestones

### 3.1 — Visitor Token Store

Build the in-memory visitor token store.

**Deliverables:**

- `packages/beacon/src/visitors/tokenStore.ts` — `VisitorTokenStore` class implementing:
  - `create(ipHash, userAgent)` → generates a new token per `REQUIREMENTS.md` §2.1 (12-char, `crypto.randomBytes(9).toString('base64url').slice(0, 12)`)
  - `get(token)` → returns `VisitorTokenRecord` or `null`
  - `touch(token)` → updates `lastSeenAt` (sliding window TTL)
  - `setAttribution(token, attribution)` → stores attribution data on the record (first-touch only — no overwrite if already set, per `REQUIREMENTS.md` §3.2)
  - `remove(token)` → deletes the record
  - `stats()` → returns `{ active, evicted }`
- TTL sweep runs every 60 seconds, removes entries where `now - lastSeenAt > visitorTokenTTL`
- Max entries enforced via `maxVisitorTokens` — when at capacity, evict oldest by `lastSeenAt` before creating new entries
- `stop()` method to clear the sweep timer for shutdown

**Tests (unit):**

- Token format: 12 characters, URL-safe
- TTL expiry removes stale tokens
- Sliding window: `touch()` resets the TTL clock
- Max entries eviction works correctly (oldest evicted first)
- First-touch attribution: second `setAttribution()` call is a no-op
- `stats()` reflects current state

### 3.2 — Attribution Capture

Build the attribution parameter extractor.

**Deliverables:**

- `packages/beacon/src/visitors/attribution.ts` — `extractAttribution(url)` function that:
  - Parses URL query parameters
  - Extracts UTM params: `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`
  - Extracts ad platform click IDs: `gclid`, `fbclid`, `msclkid`, `dclid`, `ttclid`, `li_fat_id`
  - Extracts custom params with `_bcn_` prefix (strips the prefix in the stored key)
  - Returns `Attribution` object or `null` if no relevant params found
- `Attribution` type definition in `packages/beacon/src/types.ts`

**Tests (unit):**

- Extracts all UTM params correctly
- Extracts all ad platform click IDs
- Extracts custom `_bcn_` prefixed params, strips prefix
- Returns `null` when no attribution params present
- Handles malformed URLs gracefully

### 3.3 — Middleware Integration

Wire visitor tokens and attribution into the existing request logging middleware.

**Deliverables:**

- Update `requestLogger.ts` to:
  1. Check for authenticated user via `getUserId(c)` — if present, skip token logic, log event with `user_id`
  2. Check for `_t` query param — if present, look up token in store, call `touch()`
  3. If no user and no valid token: generate a new token via the store
  4. Extract attribution from the request URL; call `setAttribution()` on the token record
  5. Set `c.set('beaconVisitorToken', token)` on the Hono context for host app access
  6. Include `visitor_token` on the logged event
- Add `beacon.getVisitorToken(c)` convenience method
- Add `beacon.appendToken(url, c)` URL helper per `REQUIREMENTS.md` §2.3

**Tests (unit):**

- Authenticated requests skip token generation
- Unauthenticated requests without `_t` get a new token
- Unauthenticated requests with valid `_t` reuse the existing token
- Unauthenticated requests with expired/invalid `_t` get a new token
- Attribution params captured on first hit
- `beaconVisitorToken` is set on Hono context
- `appendToken()` correctly appends to URLs with and without existing query strings

### 3.4 — Visitor Association

Build the association flow that links anonymous visitor trails to authenticated users.

**Deliverables:**

- `beacon.associateVisitor(c, userId)` per `REQUIREMENTS.md` §2.4:
  1. Reads visitor token from context
  2. Looks up `VisitorTokenRecord`
  3. Batch `UPDATE beacon_events SET user_id = $1 WHERE visitor_token = $2 AND user_id IS NULL`
  4. If token record has attribution data, writes it to the `attribution` column on the user's earliest event
  5. Removes the token from the in-memory store
  6. No-op if no token found
- This is an async operation — the host app `await`s it during the auth flow

**Tests (integration):**

- Anonymous events (with visitor_token, no user_id) are updated with user_id after association
- Attribution data is written to the earliest event
- Token is removed from the store after association
- No-op when no token exists (direct login)
- Multiple anonymous events from the same token all get the user_id

---

## Exit Criteria

- Anonymous visitors receive a token that persists across page views via `_t` URL param
- UTM params and ad click IDs are captured on first hit and stored on the token record
- `beacon.associateVisitor()` links the full anonymous trail to an authenticated user
- Attribution data flows from the token record to the user's events
- Token store handles TTL, eviction, and capacity limits correctly
- All unit and integration tests pass
- `bun test` at root passes (no Phase 1 or 2 regressions)
