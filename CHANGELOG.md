# Changelog

## 0.2.16 — 2026-10-25

- Compare the served checkout with independently fetched GitHub release objects using a root-owned mirror and temporary index. Report ignored untracked files, hidden tracked edits and forged app repository state; exclude only node_modules at any depth.
- Disable automatic dotenv loading in the service and deploy install/migration processes. Continue using the explicit systemd EnvironmentFile and deploy migration environment.

The SDK, client, and server manifests all declare version `0.2.16`. SDK and client behavior is unchanged.

## 0.2.15 — 2026-10-25

- Verify managed Postgres certificates and hostnames using the optional `DATABASE_CA_CERT` PEM path in both server and migration clients. Invalid explicit CA configuration fails before connecting; unset preserves local/CI behavior.
- Provision privileged files only from a root-owned 0700 operator-delivered bundle. Resolve the integrity check's release authority directly from GitHub with pinned host keys; fail on sudo/admin group membership.
- Operator cut-over before release: install the cluster CA and env line, prove private-host certificate verification, then release. After release, deliver origin/main's root bundle, rerun provisioning and walk the installed integrity check. See DEPLOYMENT.md and OPERATIONS.md for CA rotation and the external health-monitor contract.

The SDK, client, and server manifests all declare version `0.2.15`. SDK and client behavior is unchanged.

## 0.2.14 — 2026-10-24

- Separate full-sudo operator `paul` from the SSH-disabled app user, whose only sudo permission restarts Beacon. Preserve rotated operator keys on provisioning reruns.
- Install a weekly/boot host integrity timer with eleven named checks and a root-owned baseline; send drift and aborted-run alerts directly through Resend. Alert credentials require operator setup.

The SDK, client, and server manifests all declare version `0.2.14`. SDK and client behavior is unchanged.

## 0.2.13 — 2026-10-24

- Publish CI-gated releases for a minute droplet timer to pull; remove inbound GitHub SSH deployment. Reject off-main releases and automatic downgrades, serialize deploys, and suppress repeated failed targets.
- Report the running process boot commit in DB-free `/health`; CI waits for that exact commit.
- Provision Tailscale, SSH/UFW hardening after enrollment, and third-party security updates with required reboots at 10:00 UTC. Document cut-over, retry and manual rollback.
- **Breaking for self-built containers:** build with `--build-arg BEACON_COMMIT="$(git rev-parse HEAD)"` from the exact clean source revision. Images without a valid full commit now fail at boot. This is image metadata; rebuild for each revision.

The SDK, client, and server manifests all declare version `0.2.13`. SDK and client behavior is unchanged.

## 0.2.12 — 2026-10-24

- Pin Bun 1.4.4 (eMudhra CA distrust, brotli CVE-2026-111497) in `.bun-version` for CI, provisioning and container builds; deployment refuses a runtime that does not match the pin.
- Upgrade Hono to 4.13.13 and Playwright to 1.64.1.
- **Breaking for self-built containers:** the host server now binds `127.0.0.1` by default (an empty `HOST` counts as unset). Set `HOST=0.0.0.0` in any image you build yourself; Beacon's own Dockerfile already does. Behind a same-host reverse proxy, no change is needed.
- A deploy that stops before restarting the service (Bun pin missing or mismatched, dependency install or migration failure) now restores the previous checkout and its dependencies and exits 3, so the next deploy's rollback target is always a commit that was installed and health-checked.
- Run CI and local tests on Postgres 17; authenticate CI service pulls to Docker Hub.

The SDK, client, and server manifests all declare version `0.2.12`. SDK and client behavior is unchanged.

## 0.2.11 — 2026-10-24

- Short-link click events retain only `code` in properties to avoid copying destination bearer credentials into analytics. Click events already stored are not rewritten.

The SDK, client, and server manifests all declare version `0.2.11`. SDK and client behavior is unchanged.

## 0.2.10 — 2026-10-24

- Configure authenticated short-link creation limits with `SHORT_LINK_CREATE_RATE_LIMIT` and `SHORT_LINK_CREATE_RATE_WINDOW_MS`; defaults remain 100 creations per hour.
- Reject invalid rate settings at startup, naming the variable before opening Postgres.

The SDK, client, and server manifests all declare version `0.2.10`. SDK and client behavior is unchanged.

## 0.2.9 — 2026-10-12

- Restore normal browser client flushes without an injected fetch by binding the default fetch to its global receiver.

The SDK, client, and server manifests all declare version `0.2.9`. SDK and server behavior is unchanged.

## 0.2.8 — 2026-10-12

- Enable exact-origin browser ingest CORS with `CORS_ORIGINS`, including credentialed native JSON sendBeacon delivery. Other server routes retain their existing behavior.

The SDK, client, and server manifests all declare version `0.2.8`. SDK and client behavior is unchanged.

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
