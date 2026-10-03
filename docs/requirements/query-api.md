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

