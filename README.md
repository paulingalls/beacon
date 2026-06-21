# Beacon

Privacy-first, cookie-free analytics for the PI Innovations product portfolio.

Beacon captures user behavior through server-side request logging and URL-based visitor tracking — no cookies, no third-party scripts, no consent banners. All data flows into a single, centralized Postgres instance with an agent-accessible query API.

This document explains **what Beacon is and why it's built this way**. For how to deploy and integrate it, see **[INTEGRATION.md](./INTEGRATION.md)**.

## Why Beacon

- **Privacy by construction.** No cookies, no `localStorage`, no device-side identifiers. A visitor token lives only as a URL parameter during a session and is never persisted on the user's device. There is nothing to consent to because nothing is stored client-side.
- **First-party, self-hosted.** Beacon is the analytics dependency — there are no external trackers. You run one Beacon server; your data never leaves your infrastructure.
- **Agent-accessible.** The query API is designed for direct use by AI agents: a `/analytics/schema` endpoint provides full introspection so an agent can discover the data model and query it with no prior knowledge (and Beacon can be exposed as an MCP server).

## The single-writer model

Beacon enforces a **physical single-writer boundary**: exactly one deployed service holds central-database write credentials, and every product emits to it over an authenticated HTTP boundary.

```
  products (no DB creds)                       the one DB writer
  ─────────────────────                        ────────────────
  Bun.serve / Hono app ─┐
  browser SPA ──────────┼──  POST /events  ──▶  deployed Beacon server ──▶  Postgres
  mobile (React Native) ─┘   (trusted bearer)    (apps/server)
```

No product — server, browser, or mobile — ever opens a Postgres connection. They emit events over `POST /events`; the deployed Beacon server is the only thing that writes the database. This keeps credentials in one place, makes the trust boundary auditable, and means a compromised product can never reach the data store directly.

## Packages

| Package | Role |
|---|---|
| `@pi-innovations/beacon` | The **HTTP-emit SDK**: framework-agnostic request capture (`createHttpBeacon`) that emits over the trusted ingest boundary. No Postgres on a consumer's emit path. |
| `@pi-innovations/beacon-client` | Lightweight TypeScript client SDK for mobile (React Native/Expo) and optional web-side event tracking. |

The deployed Beacon server itself lives in **`apps/server`** — a private application (never published) that holds the DB credentials and serves ingest, the query API, the admin dashboard, and the URL shortener.

## Privacy

Beacon operates without cookies or any client-side storage. There is no third-party data sharing, no cross-site tracking, and no persistent client-side identifiers. Visitor tokens exist only as URL parameters during a browsing session and are never stored on the user's device. IP addresses are hashed before storage by default.

## Documentation

- **[INTEGRATION.md](./INTEGRATION.md)** — how to deploy the Beacon server and integrate each kind of product (server-side, browser SPA, mobile).
- **[docs/REQUIREMENTS.md](./docs/REQUIREMENTS.md)** — the implementation contract: every field, endpoint, and config option.
- **[docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md)** — deploying the Beacon server (DigitalOcean droplet, Caddy + systemd, autodeploy).
- **[docs/BEACON_OVERVIEW.md](./docs/BEACON_OVERVIEW.md)** — product overview and design rationale.
