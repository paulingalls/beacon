// Public API for @pi-innovations/beacon-sdk.
//
// The HTTP-emit SDK surface (Milestone 4: physical single-writer boundary). The
// DB-backed createBeacon factory and the server internals it wires moved to the
// private apps/server — this package ships framework-agnostic request capture plus
// HTTP emission over the trusted ingest boundary, with no postgres on a consumer's
// emit path. The root export is exactly the AGNOSTIC surface: the emit SDK, the
// framework-agnostic capture cores, the relay interface, and the ingest wire types.
// Everything Hono-Context-coupled lives behind the './hono' subpath (Milestone 1)
// so importing createHttpBeacon loads zero hono.

// --- Capture cores: framework-agnostic request capture reused by the private
// apps/server and any Bun.serve product. DB-free, hono-free.
export type { BeaconRequest } from './adapter/beaconRequest';
export { requestToBeaconRequest } from './adapter/beaconRequest';
export { MAX_EVENT_TYPE_LENGTH } from './events/limits';
export type { EventSink } from './events/sink';
// --- Emit SDK (Milestone 3): the Bun.serve counterpart to the server's createBeacon,
// emitting over the trusted HTTP ingest boundary instead of writing Postgres directly.
export type { HttpBeacon, HttpBeaconOptions } from './httpBeacon';
export { createHttpBeacon } from './httpBeacon';
export type { EventContext, ResolvedEventFields } from './middleware/requestContext';
export {
  buildEventContext,
  firstLocale,
  hashIp,
  parseAppContext,
  resolveEventFieldsFromRequest,
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
