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

**Optional durable queue (mobile):** `BeaconClientConfig` accepts an optional `storage` adapter (`load()` / `save()` / `clear()`). When provided, the queue is persisted so pending events survive the OS killing a backgrounded app; when omitted, the queue is purely in-memory. The adapter stores only undelivered event payloads — never identifiers or tracking state — and is cleared on successful flush, so it is consistent with the no-client-side-storage constraint. The host app supplies the adapter; the SDK adds no storage dependency. See `../phases/PHASE_8_CLIENT_SDK.md` §8.1.

**Flush behavior:**
- Timer fires every `flushInterval` ms (default `30000`)
- Flush also triggered when queue reaches `maxBatchSize` (default `50`)
- `flush()` can be called manually
- Flush sends `POST` to the configured endpoint with the batch
- On network failure: batch is re-queued (once). If the retry also fails, events are dropped.
- On `4xx` response: events are dropped (client error, don't retry).
- On `5xx` response: batch is re-queued for one retry.

**`reset()`:** Clears the event queue and cancels pending timers.

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
function useBeaconLifecycle(client: BeaconClient, rn: ReactNativeBindings): void;
function useBeaconScreenViews(
    client: BeaconClient,
    route: string | null,
    react: ReactScreenBindings,
): void;
```

The host injects its React and React Native primitives; the package imports neither framework.

- Lifecycle listens to `AppState` changes and flushes on `background`.
- On `active` after a prior `background`, it tracks `app_foreground`; transient
  `inactive → active` changes emit no marker. Foreground never resets or tears down the client.
- Lifecycle removes the subscription on unmount.
- The host separately calls `getDeviceContext(rn)` for OS and window dimensions;
  device model is host-supplied rather than populated automatically.
- Screen tracking emits the first non-null route on mount and subsequent route changes,
  dedupes repeats per hook instance, and ignores null without resetting the last emitted route.
- The same Expo bundle on web uses `useBeaconScreenViews`, not `useBeaconNav`, to report
  identical route names. Callers pass route patterns, never concrete paths.

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

    // Ingest
    productAllowlist?: string[];        // opt-in; when set, a present non-allowlisted body.product_id → 403 batch drop. Must include productId. Unset = accept any (default)

    // Auth callbacks
    getUserId?: (c: Context) => string | null;      // default: () => null
    isAdmin?: (c: Context) => boolean;              // default: () => false

    // Routing
    basePath?: string;                              // default: '/analytics'

    // Middleware
    excludePaths?: string[];                        // default: []
    ipMode?: 'sha256' | 'daily-salt' | 'none';        // explicit mode conflicts with hashIPs: false
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

Integration tests use the shared DB harness in `apps/server/test/` (the server is the only
DB-cred holder; the published `@pi-innovations/beacon-sdk` ships no test entry point). The
bunfig preload (`test/setup/ensure-test-db.ts`, repo root only) starts Postgres and sets
`TEST_DATABASE_URL`; suites gate on it and register the fail-loud coverage guard:

```typescript
import { registerDbCoverageGuard, TEST_DB } from '../../apps/server/test/dbGuard';
import { withTestDb } from '../../apps/server/test/helpers';

registerDbCoverageGuard(); // fails loud if a DB is expected but TEST_DATABASE_URL is unset

describe.skipIf(!TEST_DB)('…', () => {
    const getDb = withTestDb(TEST_DB as string); // migrated client; TRUNCATE per test; DROP + close in afterAll
    // ... run tests against getDb() ...
});
```

`helpers.ts` also provides `stubSql`/`txResolver` (a `postgres.Sql` test double for DB-free unit
tests) and `ctxWith` (a minimal Hono context). There is no `createTestBeacon` factory.

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
