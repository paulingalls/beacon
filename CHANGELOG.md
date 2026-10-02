# Changelog

## 0.1.0 — 2026-10-02

- Add server-owned IP modes: legacy SHA-256, rotating daily-salt HMAC, and IP omission. The HTTP SDK can explicitly forward raw IPs for the server to transform once.
- Add path normalization to request logging and ingest, plus mapping in web navigation tracking. Null drops an event; an ingest normalization error rejects the whole batch.
- Add referrer storage modes for raw values, origins, or origins with paths.
- Add the dependency-free `useBeaconScreenViews` hook for React Native and Expo web route patterns.
- Add authorized user-event erasure, including queued and in-flight events, transactional deletion, and hashed-user audit records. Events emitted after the erasure call remain the caller's responsibility.
- Split oversized ingest tests and enforce the tracked TypeScript file-size cap.

Existing IP hashing, raw referrers, and unmapped paths remain the defaults. The SDK's existing double-hash path is preserved for compatibility; raw-IP forwarding is opt-in. Daily salts are local to each server instance and reset on restart.

The additive `003_erasures.sql` migration creates the erasure audit table. The SDK, client, and server manifests all declare version `0.1.0`.
