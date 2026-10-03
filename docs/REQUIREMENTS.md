# REQUIREMENTS.md — Beacon

This document is the implementation contract for Beacon. It covers every decision a build session needs to make. For high-level context and motivation, see `BEACON_OVERVIEW.md`.

---

## 1. Server Middleware

[Read this section](requirements/server-and-schema.md#1-server-middleware).

## 2. Visitor Token

[Read this section](requirements/server-and-schema.md#2-visitor-token).

## 3. Attribution

[Read this section](requirements/server-and-schema.md#3-attribution).

## 4. Event Schema

[Read this section](requirements/server-and-schema.md#4-event-schema).

## 5. Query API

[Read this section](requirements/query-api.md#5-query-api).

## 6. Custom Events

[Read this section](requirements/events-and-shortener.md#6-custom-events).

## 7. URL Shortener

[Read this section](requirements/events-and-shortener.md#7-url-shortener).

## 8. Client SDK (`beacon-client`)

[Read this section](requirements/client-and-operations.md#8-client-sdk-beacon-client).

## 9. Admin Dashboard

[Read this section](requirements/client-and-operations.md#9-admin-dashboard).

## 10. Configuration Reference

[Read this section](requirements/client-and-operations.md#10-configuration-reference).

## 11. Testing Strategy

[Read this section](requirements/client-and-operations.md#11-testing-strategy).

## 12. Non-Requirements (Out of Scope for v1)

[Read this section](requirements/client-and-operations.md#12-non-requirements-out-of-scope-for-v1).


Server referrer policy: `referrerMode` accepts `raw` (default), `origin`, or
`origin-and-path`. The server applies it to all newly stored `context.referrer`
values: request logger, public and trusted ingest, `Beacon.track()`, and short-link
clicks. Raw preserves input byte for byte. Scrubbing stores only the HTTP(S) origin
or origin plus path, without credentials, query or fragment; invalid or non-web
referrers leave the key absent. Landing-URL UTM/click-id attribution is unchanged,
including the SDK capture path's existing absence of attribution. Invalid config
is rejected before resource startup. The host reads optional `REFERRER_MODE`.

Server IP policy: `ipMode` accepts `sha256`, `daily-salt`, or `none`. An absent mode
preserves the legacy `hashIPs` default; explicit mode with `hashIPs: false` is rejected.
Daily-salt uses per-instance in-memory HMAC-SHA-256, rotates at UTC midnight, and
clears discarded salts. None omits stored IPs, uses a constant token seed, and retains
only ephemeral in-memory IP rate-limit keys. The SDK can opt into `forwardRawIPs`;
its default hashing and the server's legacy double hash remain compatible.

## User event erasure

`DELETE {basePath}/users/:userId/events` requires either the configured `isAdmin` predicate or
the trusted-ingest bearer. A missing or invalid credential returns 403 before any buffer or
persistence changes. It is a mutation endpoint and is not advertised in query schema discovery.

The serving instance purges the user's queued events and suppresses retries of that user's
in-flight events, then awaits the in-flight write. In one transaction it deletes all
`beacon_events` rows with that exact user ID across products and inserts an audit row into
`beacon_erasures` containing SHA-256 of the ID, the deleted count, and `erased_at`. Success returns
200 `{ count }`; a repeat returns 0 and records a 0-count erasure. Operational logs do not contain
the user ID. Audit storage contains the hash rather than the raw ID.

Any failure returns 500; database changes and the audit insert roll back together. Purged
in-memory events remain discarded, and callers can safely retry. Callers must stop emitting new
events after the call. Erasure does not coordinate other instances or block future visitor
associations, and does not remove short links or schema metadata.
