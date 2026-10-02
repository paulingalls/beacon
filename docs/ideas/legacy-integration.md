# Beacon for Cordelia — Request for Beacon Changes

**Audience:** the agent building Beacon changes.
**From:** Cordelia (the `legacy` repo), 2026-10-01.
**Status:** approved direction (Paul, 2026-10-01); no code yet. Cordelia runs its **own Beacon
deployment**; VodShorter and every other existing integration keep the default deployment and
must see **no behaviour change**.

---

## 1. Context

Cordelia is a voice-first AI biographer: an adult child (the *sponsor*) creates a *Portrait* of a
parent (the *storyteller*), the storyteller talks with the biographer, and the family receives
stories. It holds biometric-adjacent audio under BIPA, encrypts content per Portrait, and keeps
its data on its own droplets. Its business metrics design
(`legacy/docs/cordelia-metrics-design.md`) needs three things Beacon is built for:

1. **Marketing-site page views and attribution** (UTM, referrer, ad click ids, short links), with
   the anonymous trail stitched to the account created at sign-up, so each Portrait can record the
   channel that brought it. This is the CAC input.
2. **Screen views in the app**, on iOS and in the browser. Cordelia's mobile app is Expo Router;
   the `/story` web pages a family opens from a shared link are the *same Expo bundle* exported to
   web, so one hook covers both.
3. **A few server-authoritative events** (e.g. Portrait created, paid) via trusted ingest, so
   funnels can be built inside Beacon too. Cordelia's own database stays the source of truth for
   business outcomes.

Grafana (already run by Cordelia) will read Beacon's Postgres directly, read-only, to put page and
screen funnels on the business board beside Cordelia's own metrics.

## 2. Hard rule: backwards compatible

Every change below is **opt-in by configuration**. With no new config set, Beacon behaves exactly
as it does at `2584ed3`: same schema (additive migrations only, per the existing guard), same
ingest wire contract, same defaults, same SDK exports. Each change ships with a test proving the
default path is unchanged. VodShorter's deployment upgrades without editing its config.

## 3. Changes requested

Ranked; R1–R5 are needed before Cordelia sends any data.

### R1. Unlinkable IP hashing (server and SDK)

Today `hashIPs: true` stores an **unsalted SHA-256** of the IP. The IPv4 space is 2^32, so every
hash reverses to its IP in minutes: it is pseudonymous, not anonymous.

Add `ipMode: 'sha256' | 'daily-salt' | 'none'` (default `'sha256'`, today's behaviour; the
existing `hashIPs: false` keeps meaning raw).
- `'daily-salt'`: HMAC-SHA-256 with a random salt generated in memory at each UTC midnight and
  **never persisted or logged**; the previous day's salt is discarded. Same-day unique counts
  still work; yesterday's hashes cannot be reversed or joined to today's. (This is Plausible's
  method.) Visitor-token records and rate-limit keys use the same value.
- `'none'`: no IP-derived value stored at all; rate limiting keys on an in-memory value only.
- Cordelia sets `'daily-salt'`. Recommend making it the default in a later major version.

### R2. Path normalisation (server middleware, ingest, web client)

Cordelia's paths carry identifiers: `/p/<legacyId>/story/<storyId>`, and bearer tokens in
`/invitations/<token>/preview` and the shared-story links. A raw path in an analytics table is a
pseudonymous record of which family read which story, and a token in one is a credential at rest.

- Server: `normalizePath?: (path: string) => string | null` on the request logger and the ingest
  handler (applied to `properties.path` of `page_view`/`screen_view` events). Returning `null`
  drops the event. Default: identity.
- Web client: `useBeaconNav` accepts `toPath?: (pathname: string) => string | null`; the
  same contract. Default: identity.
- Cordelia passes route patterns (`/p/[legacyId]/story/[storyId]`) computed from Expo Router.

### R3. Referrer and URL scrubbing

`context.referrer` stores the raw `Referer` header, which can carry another site's query string
or one of Cordelia's own tokens. Add `referrerMode: 'raw' | 'origin' | 'origin-and-path'`
(default `'raw'`). Cordelia sets `'origin'`. Attribution parameters are still captured from the
landing URL as today; only the stored referrer changes.

### R4. Screen views for React Native

The React Native wrapper only flushes on app background. Add, in `beacon-client`'s
`platform/reactNative`, a router-agnostic hook in the existing binding-injection style (no Expo
or React Navigation dependency):

```ts
useBeaconScreenViews(client: BeaconClient, route: string | null): void
```

It emits `screen_view { route }` when `route` changes, dedupes repeats, ignores `null`, and emits
the first non-null route on mount. Cordelia computes `route` from Expo Router's `useSegments()`
and passes the pattern, never the concrete path. On web the same Expo bundle should use this hook
too (not the History-API wrapper), so app and web report identical route names; document that.

### R5. Erasure: delete a user's events

Cordelia must honour deletion requests (GDPR Art. 17, its own Portrait deletion). Beacon has no
way to remove a user's events, and events stitched from a visitor token become the user's.

- Admin endpoint `DELETE {basePath}/users/:userId/events` (admin bearer), deleting every
  `beacon_events` row with that `user_id`, returning the count, and writing no PII to logs.
- The same through the trusted-ingest bearer, so Cordelia's erasure job can call it.
- A `beacon_erasures` table (user id hash, count, time) so a deletion is provable without
  keeping the id in clear. Additive migration.

### R6. Retention pruning

`retentionDays` is specified (REQUIREMENTS §4.3) but no pruning job exists. Implement it as
specified, off unless configured, so the default deployment keeps everything as today. Cordelia
sets a value matching its privacy policy.

### R7. Grafana-friendly read access

- A documented, migration-created read-only role (`beacon_reader`, SELECT on `beacon_events`,
  `beacon_meta`, `beacon_short_links`) whose password is set by the operator, so a dashboard reads
  without the writer's credentials.
- Indexes already cover `(product_id, event_type, timestamp)`; add `(product_id, user_id,
  timestamp)` only if a funnel query needs it (measure first).

### R8. Self-contained deployment

Cordelia will run Beacon as a container on its ops droplet with its **own** Postgres database,
behind its existing Caddy and admin IP allowlist.
- Confirm (and test) that the server makes **no outbound network calls** other than its Postgres.
- Publish the Dockerfile's image build as the supported deployment path beside the systemd one;
  document required env, health check, and graceful shutdown under `docker stop`.
- New env for R1–R6 (`IP_MODE`, `REFERRER_MODE`, `RETENTION_DAYS`) mapped onto the config, each
  unset by default.

## 4. Not requested

- No change to the visitor-token mechanism, attribution capture, shortener, dashboard, funnel or
  attribution query semantics.
- No Cordelia-specific code in Beacon: product specifics (route patterns, which events) stay in
  the `legacy` repo.
- No content, names, story text or audio ever enters Beacon; Cordelia's integration enforces
  that, and R2/R3 make it hard to do by accident.

## 5. Acceptance

- Default-path regression: the existing test suite passes unchanged, plus one test per change
  proving that with the new option unset the stored event is byte-identical to today's.
- R1: two events from one IP on one day share a hash; across a midnight rollover they do not; no
  salt appears in Postgres, logs or `/analytics/schema`. Fault case: a persisted salt is caught.
- R2/R3: a path containing an id or token is stored as its pattern / origin; `null` drops it.
- R4: route changes emit once each; repeats and `null` do not.
- R5: after the delete, zero rows for the user; the erasure row exists; a second delete returns 0.
- R6: rows older than the window are removed; with retention unset nothing is removed.
- R8: a container run with network egress blocked except Postgres serves ingest and the query API.

## 6. Open questions for the Beacon build

1. Should `daily-salt` become the default at the next major version (recommended)?
2. Does VodShorter want R5 (erasure) too? It costs nothing to enable.
3. Release mechanics: tag a version Cordelia pins, via the existing git artifact branches.
