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


Server IP policy: `ipMode` accepts `sha256`, `daily-salt`, or `none`. An absent mode
preserves the legacy `hashIPs` default; explicit mode with `hashIPs: false` is rejected.
Daily-salt uses per-instance in-memory HMAC-SHA-256, rotates at UTC midnight, and
clears discarded salts. None omits stored IPs, uses a constant token seed, and retains
only ephemeral in-memory IP rate-limit keys. The SDK can opt into `forwardRawIPs`;
its default hashing and the server's legacy double hash remain compatible.
