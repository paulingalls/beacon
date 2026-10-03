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
    "visitor_token": "a1b2c3d4e5f6",
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
- `product_id` is honored from the request body when present and valid (a non-empty trimmed string ≤100 chars), enabling a shared multi-product ingest endpoint; an absent or invalid value falls back to the host app's configured product (a present-but-invalid value is logged but never rejects the batch)
- When `productAllowlist` is configured (§10), a **present** `product_id` that is invalid-shape or not in the allowlist rejects the whole batch: `403 UNAUTHORIZED`, batch dropped, nothing stored, and the dropped event count is logged. An **absent** `product_id` is unaffected — it still falls back to the configured product (which must itself be in the allowlist). When `productAllowlist` is unset, any `product_id` is accepted (the fallback behavior above)
- `visitor_token` is an **optional, anonymous** body-level field that lets a cookie-free browser SPA carry its own pre-auth visitor handle (a SPA POSTs cross-origin, so it has no URL `_t` and no shared transport context). A valid body value (a non-empty trimmed string ≤100 chars) **wins**; the transport token minted from the URL `_t` param is the fallback; an invalid value is treated as absent and never rejects the batch (skip-not-reject, like `product_id`). The host seeds this token into the SPA bootstrap and the client holds it in memory only — no cookie, no storage
- `platform` is inferred from the `X-App-Context` header or the host app's config
- `user_id` is inferred from the auth context only; a body-level `user_id` is **not** honored on this public endpoint (a browser must not be able to assert another user's identity). Authenticated server-to-server callers asserting `user_id` are introduced separately behind a trusted bearer auth mode (see Milestone 2)

Returns `202 Accepted` with `{ "accepted": <count>, "product_id_used": <product_id> }`, where `product_id_used` is the product the batch was attributed to (the resolved body or configured fallback) so a caller can detect a mismatch. Events are buffered, not written synchronously.

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

