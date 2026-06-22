// Public API for @pi-innovations/beacon-sdk.
//
// The HTTP-emit SDK surface (Milestone 4: physical single-writer boundary). The
// DB-backed createBeacon factory and the server internals it wires moved to the
// private apps/server — this package ships framework-agnostic request capture plus
// HTTP emission over the trusted ingest boundary, with no postgres on a consumer's
// emit path. The exported surface is exactly: the emit SDK, the framework-agnostic
// capture cores apps/server (and any Bun.serve consumer) build on, and the ingest
// wire-contract types.

// --- Capture cores: framework-agnostic request capture reused by the private
// apps/server and any Bun.serve product. DB-free.
export type { BeaconRequest } from './adapter/beaconRequest';
export { honoToBeaconRequest, requestToBeaconRequest } from './adapter/beaconRequest';
export type { EventSink } from './events/sink';
export type { TrackOptions } from './events/track';
export { MAX_EVENT_TYPE_LENGTH, track } from './events/track';
// --- Emit SDK (Milestone 3): the Bun.serve counterpart to the server's createBeacon,
// emitting over the trusted HTTP ingest boundary instead of writing Postgres directly.
export type { HttpBeacon, HttpBeaconOptions } from './httpBeacon';
export { createHttpBeacon } from './httpBeacon';
export type {
  EventContext,
  ResolvedEventFields,
  ResolveEventFieldsOptions,
} from './middleware/requestContext';
export {
  buildEventContext,
  defaultClientAddress,
  firstLocale,
  hashIp,
  honoRequest,
  parseAppContext,
  resolveEventFields,
  resolveEventFieldsFromRequest,
  resolveIp,
  resolveIpFromRequest,
} from './middleware/requestContext';
// --- Relay interface (Milestone 7): trusted server-side client-relay ingest + identify.
// A product backend mounts these to forward a client's batch / stitch a login under the
// trusted bearer. Also reachable at the '@pi-innovations/beacon-sdk/relay' subpath.
export * from './relay';
// --- Wire-contract types (the ingest boundary's shared shapes).
export type {
  Attribution,
  BeaconEvent,
  BufferStats,
  VisitorTokenRecord,
} from './types';
export { extractAttribution } from './visitors/attribution';
