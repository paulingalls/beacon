# Beacon

**A first-party, privacy-first analytics platform for PI Innovations**

Beacon is a lightweight, self-hosted analytics stack designed to provide full-funnel product analytics across the PI Innovations portfolio without cookies, third-party dependencies, or consent banners. It captures user behavior through server-side request logging, URL-based visitor tracking, and a minimal client SDK for mobile platforms — all feeding into a centralized data store with an agent-accessible query API.

---

## Design Philosophy

- **First-party only.** All data is collected and stored on PI Innovations infrastructure. No third-party analytics scripts, no external tracking pixels, no data leaving our systems.
- **No client-side storage of tracking state.** No cookies, no localStorage, no fingerprinting, no persisted identifiers. This eliminates the need for GDPR/ePrivacy cookie consent banners across all products. (The mobile SDK's transient outbound event queue, which carries no identifiers, is the sole permitted on-device buffer.)
- **Server-side first.** The primary collection mechanism is HTTP request logging via server middleware. The client SDK exists only to supplement with mobile-specific context and client-side events.
- **Agent-native query interface.** Rather than building exhaustive dashboards, Beacon exposes a well-documented query API that AI agents can introspect and use to answer ad-hoc analytics questions.
- **Shared infrastructure.** One analytics platform, one data store, one query API across all PI Innovations products.

---

## Architecture

### Packages

| Package | Description |
|---|---|
| `@pi-innovations/beacon` | Server-side Hono middleware, event helpers, query engine, API router, and admin dashboard |
| `@pi-innovations/beacon-client` | Lightweight TypeScript client SDK for mobile (React Native/Expo) and optional web client-side event tracking |

### Infrastructure

- **Data Store:** Centralized Postgres instance shared across all PI Innovations products. Every event includes a `product_id` dimension, enabling both per-product and cross-portfolio analysis.
- **Deployment:** Hosted alongside existing PI Innovations infrastructure.

---

## Data Collection

### Web — Authenticated Users

For logged-in users, the server middleware automatically captures every request with no client-side instrumentation needed.

Captured fields:

- Authenticated user ID
- Request path, method, timestamp
- Response status and timing
- Referrer header
- User-agent (device/browser/OS)
- Accept-language (locale)
- IP address (geolocation, unique visitor estimation)

### Web — Pre-Auth Visitors

Anonymous visitors are tracked using a server-generated visitor token appended to internal links as a URL query parameter (e.g., `?_t=abc123`).

Behavior:

- Token generated on first hit, included in all rendered internal links
- Middleware reads the token on each request, logging the full click trail
- Token mapped to the real user ID upon signup/login
- Tokens are short-lived (e.g., 30-minute TTL in memory)
- Token stripped from external outbound links to prevent leakage via referrer headers
- Passed as a hidden field in form submissions to survive POSTs

Limitations:

- Breaks on direct URL navigation or bookmarks (a new anonymous trail begins)
- Only effective in server-rendered or hybrid flows where the server controls link output

### Campaign Attribution

URL query parameters are captured on first hit:

- UTM tags: `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`
- Ad platform click IDs: `gclid`, `fbclid`, etc.
- Custom PI Innovations campaign identifiers

Attribution data is held in a short-lived store (keyed by visitor token or IP+user-agent) and flushed to the user profile on authentication.

### Mobile — Authenticated Users

API calls from mobile apps are logged by the same server middleware. App-specific context is sent via a custom header (e.g., `X-App-Context`) containing:

- App version
- OS and OS version
- Device model
- Screen dimensions

This header is set once at app startup and attached to every outgoing request by the HTTP client layer.

### Mobile — Client-Side Events

Events that don't correspond to API calls (screen views, UI interactions, time-on-screen) are collected by the `beacon-client` SDK:

- Events buffered in memory as a lightweight array
- Batch flushed to a `POST /analytics/events` endpoint on a periodic interval (e.g., every 30 seconds)
- Flush also triggered on app backgrounding
- Event queue reset on app foregrounding

### Custom Product Events

Route handlers can log meaningful product-level events using a lightweight event helper:

- Examples: "user created a clip," "user exported a contact," "user started a session"
- Captured as structured events with arbitrary properties
- No client-side instrumentation required for server-initiated actions

---

## Event Schema

All events share a common structure regardless of source:

| Field | Description |
|---|---|
| `event_id` | Unique event identifier |
| `product_id` | PI Innovations product identifier |
| `timestamp` | Event time (server clock) |
| `event_type` | Event category (e.g., `page_view`, `api_call`, `screen_view`, `custom`) |
| `user_id` | Authenticated user ID (nullable for anonymous visitors) |
| `visitor_token` | Pre-auth visitor token (nullable for authenticated users) |
| `platform` | `web`, `ios`, `android` |
| `properties` | Arbitrary JSON payload with event-specific data |
| `context` | Request metadata: IP, user-agent, referrer, locale, device info |
| `attribution` | Campaign metadata: UTM params, click IDs, source |

---

## Query API

### Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /analytics/schema` | Discover available event types, fields, dimensions, and data ranges. Entry point for agent-driven queries. |
| `GET /analytics/events` | Filtered event stream. Supports time range, product, event type, user, and platform filters. |
| `GET /analytics/aggregate` | Aggregation queries: counts, uniques, grouped by any dimension. |
| `GET /analytics/funnel` | Funnel analysis: ordered event sequences with conversion rates between steps. |
| `GET /analytics/attribution` | Campaign performance: source breakdown, conversion by campaign. |

### Agent Integration

The query API is designed to be agent-friendly:

- The `/analytics/schema` endpoint provides full introspection, allowing an agent to discover what data is available before constructing queries.
- All endpoints return consistent, well-structured JSON.
- Can be exposed as an MCP server, enabling direct access from Claude (Claude Code, chat, or custom agent setups).
- Agents query the API to answer ad-hoc natural language questions about product performance without requiring pre-built reports.

### Admin Dashboard

A simple built-in HTML dashboard mounted at a configurable path (e.g., `/analytics`) behind admin authentication. Covers the basics:

- Visitor and user counts
- Top pages / screens
- Attribution breakdown
- Conversion funnel
- Product selector for cross-portfolio view

This dashboard consumes the same query API, serving as both a quick-glance tool and a reference implementation.

---

## URL Shortener

A companion service running on the same Postgres instance, providing branded short links across all PI Innovations products.

### How It Works

- Table mapping short codes to destination URLs with campaign metadata baked in
- Hono route performs lookup and issues a 302 redirect
- Every redirect is logged as an analytics event before the user reaches the destination
- Attribution context (campaign, source, medium) is stored on the short link record, not in URL parameters on the destination

### Benefits

- Clean destination URLs — no long UTM strings that platforms can strip or mangle
- Full click attribution captured before the user hits the product landing page
- Single short domain across all products, giving PI Innovations a branded touchpoint
- Short link click events join directly with downstream signup and usage events in the same Postgres instance

---

## Cross-Product Data Model

All data lives in a single Postgres database with `product_id` as a first-class dimension on every table.

This enables:

- **Per-product analysis:** Filter to a single product for focused investigation
- **Portfolio-level analysis:** Query across all products for trends, comparisons, and aggregate health
- **Cross-product user tracking:** Identify users who engage with multiple PI Innovations products
- **Unified agent access:** One MCP server, one schema endpoint, one connection for all analytics queries

### Products

| Product | Platform |
|---|---|
| Clipcast | Web |
| Divine Ruin | Web / Mobile |
| VodShorter | Web |
| SimplyHuman | Web |
| ContactForge | macOS / Web |
| xp-agents | CLI / Web |

---

## Privacy Posture

- No cookies, and no client-side storage of identifiers or tracking state of any kind (the mobile SDK may persist a transient outbound event buffer — events awaiting delivery — but it holds no identifiers and is cleared on flush)
- No third-party data sharing
- No cross-site tracking
- Server-side collection only (supplemented by opt-in client SDK for mobile)
- Visitor tokens are opaque, short-lived, and never stored on the client device
- IP addresses can be hashed or truncated for additional privacy
- Architecture is designed to satisfy GDPR, ePrivacy Directive, and CCPA requirements without cookie consent banners
- Consult a privacy attorney for formal compliance confirmation

---

## Tech Stack

- **Runtime:** Bun
- **Server framework:** Hono
- **Database:** PostgreSQL
- **Client SDK:** Plain TypeScript (platform-agnostic core with thin React Native wrappers)
- **Package scope:** `@pi-innovations/beacon`, `@pi-innovations/beacon-client`
- **Hosting:** Self-hosted on PI Innovations infrastructure

---

## Products Using Beacon

Beacon is designed as shared infrastructure for the entire PI Innovations portfolio. Each product integrates via the Hono middleware (server) and/or client SDK (mobile), with all data flowing to the centralized Postgres instance.
