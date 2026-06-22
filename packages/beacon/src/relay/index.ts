// Public surface of the trusted client-relay interface (execution_plan.json §Milestone 7).
// A product backend mounts these handlers so a beacon-client device emits through the
// backend instead of straight to Beacon: the backend resolves the authenticated user and
// forwards under the M2 trusted bearer (the device never holds the secret). Re-exported
// from the package root and reachable at the `@pi-innovations/beacon-sdk/relay` subpath.
//
// Only the consumer-facing API is exported here — the shared result.ts internals
// (forwardJson/classify/resultToResponse) stay private to the relay modules.

export type { IdentifyRelayOptions, RelayIdentifyOptions } from './identifyRelay';
export { createIdentifyRelay, relayIdentify } from './identifyRelay';
export type {
  ClientBatch,
  IngestRelayOptions,
  RelayBatchOptions,
  RelayResult,
} from './ingestRelay';
export { createIngestRelay, relayBatch } from './ingestRelay';
