# Beacon Integration — Request for Beacon Changes

**Audience:** Beacon maintainers.
**From:** VodShorter.
**Status:** Design discussion — proposes Beacon-side changes to make VodShorter integration clean. No code committed against these yet.

---

## 1. Context

VodShorter wants full-funnel analytics through Beacon, emitting into Beacon's **central Postgres**, consumed via Beacon's own deployed dashboard / query API / MCP. VodShorter does **not** want to host the dashboard, query API, or shortener itself ("emit-only" scope).

VodShorter's architecture matters here:

- **Server:** `Bun.serve()` with a `routes` map, every API route wrapped in a shared `apiHandler()`. **Not Hono.**
- **Database:** `Bun.sql` (Bun-native). Project convention forbids `pg` / `postgres.js` in first-party code.
- **Frontend:** **React 19 single-page app** — one client-bundled `index.html` served at `/*`, with a custom client-side router. In-app navigation happens in the browser with **no server round-trip**. Auth is magic-link → session cookie.

The SPA point is the crux of everything below.

## 2. What VodShorter wants from analytics

Restating the product intent in Beacon's terms:

1. **Transparent navigation tracking.** As a user moves through the app, emit page/screen-view events without us hand-instrumenting every route — "handle it and hide it from us."
2. **Visitor identity continuity.** Keep a stable handle on *who is who* across a pre-auth session, and stitch that trail to the real `user_id` on login/signup.
3. **Explicit in-page events.** Let us add `track('clip_play_clicked', {...})`-style calls for interactions that don't drive navigation, so we can follow a user *around a single page*.
4. **Server-authoritative events.** Some events are only known to our server and must not be trusted from the browser — e.g. `purchase_completed` (Stripe webhook) and `job_completed` (the Mac daemon). These have no browser in the loop.

## 3. What Beacon provides today (as we read the code)

Beacon ships two emission surfaces:

### 3a. In-process server library — `createBeacon()` (the README's headline path)

- `beacon.middleware()` — Hono middleware that logs every request and issues/reads a URL visitor token.
- `beacon.track(c, type, props)`, `beacon.appendToken(url, c)`, `beacon.getVisitorToken(c)`, `beacon.associateVisitor(c, userId)` — all take a Hono **`Context`**.
- Writes events **directly to Postgres** via an internal buffer (`postgres.js` pool opened inside the host app).

Faithful to `BEACON_OVERVIEW.md`'s "server-side first" intent. But for VodShorter it implies: (a) a Hono `Context` we don't have, (b) a `postgres.js` dependency our convention forbids, (c) shared DB credentials + a network path from our droplet to Beacon's Postgres, and (d) — decisively — it's **server-rendered-first**.

### 3b. HTTP client SDK — `@pi-innovations/beacon-client` + `POST {basePath}/events`

- `BeaconClient` batches events and POSTs `{product_id, events:[...]}` to the ingest endpoint (public, rate-limited).
- The web wrapper `useBeaconWeb` flushes on `visibilitychange → hidden` and `beforeunload` (via `navigator.sendBeacon`).

Two hard limits for our use case, both confirmed in the source:

- **The client payload carries no identity.** `BeaconEvent = { eventType, properties?, timestamp? }`. There is no `user_id` and no `visitor_token` field. On ingest (`api/ingest.ts`), `user_id`, `visitor_token`, `ip`, and `context` are resolved **once per batch from the transport request** (`getUserId(c)`, `c.get('beaconVisitorToken')`, request headers) and shared across every event in the batch.
- **The web wrapper does not track navigation.** It is lifecycle-flush only — no `page_view` on route change.

## 4. The mismatch: intent is server-rendered-first; VodShorter is a client-rendered SPA

`BEACON_OVERVIEW.md` is explicit (§"Web — Pre-Auth Visitors"): visitor tracking is a server-generated token "appended to internal links as a URL query parameter," and "Only effective in server-rendered or hybrid flows where the server controls link output."

VodShorter is the opposite — a client-rendered SPA:

- The server sees the **initial document load** and the **`/api/*` fetch calls**, but **not** client-side route changes. Server middleware therefore captures API traffic, not user-perceived navigation.
- **URL-token visitor stitching cannot work**: React renders links in the browser, so the server never injects `?_t=`. `appendToken` is a server-render helper.
- **In-page button clicks are client-only** — the server never sees them. That is inherently the browser SDK's job.
- The browser SDK, as built, **carries no visitor/user identity**, so it cannot "keep a handle on who is who" on its own.

**Net:** neither surface delivers "SPA navigation + in-page events + pre-auth identity continuity" out of the box. This is not an execution defect — Beacon faithfully implements a server-rendered-first design. It's an architecture-fit gap for SPA products. (Note: the portfolio in `BEACON_OVERVIEW.md` lists VodShorter, Clipcast, SimplyHuman, and Divine Ruin as web products — several are likely SPAs, so this is probably a shared need, not a VodShorter-only one.)

## 5. Proposed Beacon changes (the asks)

We'd like Beacon to grow a **first-class browser SPA client** plus **trusted server-side ingestion**. Concretely, in rough priority order:

### Ask 1 — Visitor identity in the client SDK *(highest value)*

Let `BeaconClient` hold and transmit identity so a cookie-free SPA can maintain "who is who":

- Config/state for a `visitorToken` (and optional `userId`), sent per-batch (or per-event) in the POST body.
- The token is **seeded by the host server into the initial HTML/bootstrap** (the SPA's single server-rendered touchpoint), carried by the client **in memory only** (no cookie, no `localStorage` — preserves the no-client-storage posture), and attached to every event batch.
- Reload mints a fresh token — the documented "new anonymous trail on reload" limitation, which we accept.

This requires the ingest endpoint to read `visitor_token` / `user_id` from the **body** for these callers, not only from the transport context.

### Ask 2 — An HTTP `identify` / `associateVisitor` path

Today `associateVisitor` is an in-process, DB-touching method taking a Hono `Context` — there is no HTTP equivalent. We need the SPA to call something on login/signup (or send an `identify` event) so the pre-auth visitor trail back-fills to the real `user_id`.

### Ask 3 — A navigation-aware web wrapper

Extend `useBeaconWeb` (or add a sibling) to auto-emit `page_view` on client-side route changes — e.g. by wrapping the History API (`pushState`/`replaceState`/`popstate`) or accepting a route-change callback — and to expose `track('...')` for in-page events. Goal: the host wires it once and "doesn't think about it." It should consume the Ask 1 identity so navigation + clicks share one visitor handle.

### Ask 4 — Trusted server-to-server ingestion for server-authoritative events

For events only our server knows (`purchase_completed` from the Stripe webhook, `job_completed`/`job_failed` from the Mac daemon), we need to POST from our server without a browser in the loop. The current ingest's "resolve identity+context once per request from the transport" model is wrong for a server relaying on behalf of users. We'd want:

- **Per-event identity + context in the body**: `user_id`, `visitor_token`, and a `context` block (`ip`, `user_agent`, `referrer`) per event, since one server connection may carry events for different users.
- **A trusted-caller auth mode** (shared secret / bearer) that authorizes a server to *assert* `user_id` on users' behalf — the public ingest must not let arbitrary callers spoof identities.

## 6. Resulting VodShorter integration shape (hybrid)

With the above, VodShorter integrates with **zero Hono and zero `postgres.js`** on our side:

- **Browser (extended web SDK):** navigation `page_view`s, in-page `track()` events, visitor identity continuity, `identify()` on login. → `POST /analytics/events`.
- **Server (HTTP relay, trusted auth):** `purchase_completed`, `job_completed`, `job_failed`, and any other server-authoritative funnel events, with per-event identity+context. → `POST /analytics/events`.
- **Funnel of interest:** `page_view → signup → job_created → purchase_completed → clip_downloaded`.

No shared DB credentials, no network path to Beacon's Postgres, clean service boundary, and our "Bun.sql only" convention preserved.

## 7. Alternative we explicitly considered and set aside

The in-process library (§3a) made framework-agnostic — replace the Hono `Context` with a minimal adapter so `track()`/middleware take a plain Request-shaped object. This would let us emit from `apiHandler()`. We set it aside because: it still can't see SPA navigation or in-page clicks (same server-rendered-first limitation), it drags `postgres.js` + shared DB creds into VodShorter, and it's a larger, more invasive Beacon refactor than extending ingest + the client SDK. The hybrid in §5–6 is cleaner for an SPA product and likely reusable across the portfolio's other web SPAs.

## 8. Open questions for the Beacon devs

1. Is a browser-side SPA client in scope for Beacon's roadmap, or is the "server-side first" stance intentional and fixed? (If fixed, we'll need an alternative for SPA navigation/identity.)
2. Preferred carrier for client identity — per-batch body fields, per-event fields, or a signed token? Any privacy constraints on a server-seeded in-memory visitor token?
3. Preferred trusted-server auth scheme for Ask 4 (shared secret bearer, mTLS, signed request)?
4. Should `associateVisitor` over HTTP be a dedicated endpoint or an `identify` event type the query layer interprets?
5. Does extending ingest to accept body-level identity/context risk the existing single-user mobile-SDK path? (We think it's additive, but you own that contract.)
