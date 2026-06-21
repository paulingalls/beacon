// Public API for @pi-innovations/beacon.
//
// The HTTP-emit SDK surface (Milestone 4: physical single-writer boundary). The
// DB-backed createBeacon factory and the server internals it wires moved to the
// private apps/server — this package ships framework-agnostic request capture plus
// HTTP emission over the trusted ingest boundary, with no postgres on a consumer's
// emit path. During the M4 migration the still-resident server internals are reached
// by apps/server through the interim `./internal/*` subpath export (package.json),
// removed in story-005.

// Re-exported so a host (apps/server) can gate its own surfaces with the same audited
// constant-time bearer compare instead of forking the logic (e.g. makeIsAdmin).
// Stays until story-004 relocates the ingest/auth path into apps/server.
export { verifyTrustedBearer } from './api/auth';
export type { HttpBeacon, HttpBeaconOptions } from './httpBeacon';
// Framework-agnostic factory (Milestone 3): the Bun.serve counterpart to the server's
// createBeacon, emitting over the trusted HTTP ingest boundary instead of writing
// Postgres directly.
export { createHttpBeacon } from './httpBeacon';
export type { BeaconConfig, BeaconEvent, BufferStats } from './types';
