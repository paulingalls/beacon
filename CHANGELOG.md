# Changelog

## 0.2.7 — 2026-10-06

- Allow optional properties on client screen views, with the supplied screen name always taking precedence.
- Forward optional route properties through `useBeaconScreenViews` only when a new route emits; same-route renders remain deduplicated and properties do not carry forward.

The SDK, client, and server manifests all declare version `0.2.7`. SDK and server behavior is unchanged.

## 0.2.6 — 2026-10-06

- Preserve the optional capture timestamp in SDK `track()` so relayed events cannot cross an erasure cutoff; omitted timestamps still use push time.
- Reject invalid track timestamps synchronously without buffering an event.

The SDK, client, and server manifests all declare version `0.2.6`. Server and client behavior is unchanged.

## 0.2.5 — 2026-10-06

- Refuse delayed user events stamped at or before an erasure cutoff at the event insertion boundary.
- Keep anonymous replay at or before the cutoff anonymous during visitor association.
- Serialize erasure, insertion, and visitor association across server instances; count only admitted rows in metadata and flushed statistics.

The SDK, client, and server manifests all declare version `0.2.5`. SDK and client behavior is unchanged.

## 0.2.4 — 2026-10-04

- Consolidate dashboard tests at the served browser boundary: cover recovery, safe text, latest controls, attribution, funnels, bounded top pages and local calendar dates; remove six duplicate unit suites.

The SDK, client, and server manifests all declare version `0.2.4`. No application behavior changes.

## 0.2.3 — 2026-10-04

- Test maintenance: remove synthetic suite-registration and observer-classifier controls and the trivial browser smoke test. Retain live deployment, privacy, and dashboard behavior checks.

The SDK, client, and server manifests all declare version `0.2.3`. No application behavior changes.

## 0.2.2 — 2026-10-04

- Update project constraints to the xp-plugin v1 template, preserving Beacon’s product rules and adopting the 4,500-byte file cap.

The SDK, client, and server manifests all declare version `0.2.2`. No application behavior changes.

## 0.2.1 — 2026-10-02

- Remove attached anonymous Postgres data volumes when disposable worktrees are torn down. Refuse teardown from the primary checkout and preserve named volumes and unrelated Docker projects.

The SDK, client, and server manifests all declare version `0.2.1`. No application behavior or production database changes are required.

## 0.2.0 — 2026-10-02

- Add opt-in event retention through `retentionDays` and `RETENTION_DAYS`. Unset or zero keeps retention disabled; pruning uses bounded batches and shutdown awaits in-flight work.
- Add an idempotent operator script for the Grafana `beacon_reader` role. It reads Beacon tables and can create temporary tables, while permanent schema changes and writes remain forbidden.
- Support self-contained container deployment behind Caddy, with a DB-free healthcheck, migration instructions, graceful shutdown, and verified private-network isolation. The strict outbound profile uses Postgres's numeric private address; refresh it after recreating Postgres.
- Reuse one Postgres container per container acceptance suite, with separate scenario databases and verified cleanup after success and failure.

The SDK, client, and server manifests all declare version `0.2.0`. No new database migration is required. Existing retention and privacy defaults remain unchanged.

## 0.1.0 — 2026-10-02

- Add server-owned IP modes: legacy SHA-256, rotating daily-salt HMAC, and IP omission. The HTTP SDK can explicitly forward raw IPs for the server to transform once.
- Add path normalization to request logging and ingest, plus mapping in web navigation tracking. Null drops an event; an ingest normalization error rejects the whole batch.
- Add referrer storage modes for raw values, origins, or origins with paths.
- Add the dependency-free `useBeaconScreenViews` hook for React Native and Expo web route patterns.
- Add authorized user-event erasure, including queued and in-flight events, transactional deletion, and hashed-user audit records. Events emitted after the erasure call remain the caller's responsibility.
- Split oversized ingest tests and enforce the tracked TypeScript file-size cap.

Existing IP hashing, raw referrers, and unmapped paths remain the defaults. The SDK's existing double-hash path is preserved for compatibility; raw-IP forwarding is opt-in. Daily salts are local to each server instance and reset on restart.

The additive `003_erasures.sql` migration creates the erasure audit table. The SDK, client, and server manifests all declare version `0.1.0`.
