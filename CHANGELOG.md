# Changelog

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
