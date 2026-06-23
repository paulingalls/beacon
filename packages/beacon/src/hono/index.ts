// Public surface of the Hono adapter (execution_plan.json §Milestone 1).
//
// Everything Hono-Context-/getConnInfo-coupled lives here, behind the opt-in
// `@pi-innovations/beacon-sdk/hono` subpath, so the framework-agnostic root entry
// (createHttpBeacon + the capture cores) loads zero hono. The deployed Hono host
// (apps/server) and any consumer running under Hono import these; a Bun.serve or
// other non-Hono product never touches this module.

export { honoToBeaconRequest } from './requestAdapter';
export type { ResolveEventFieldsOptions } from './requestContext';
export {
  defaultClientAddress,
  honoRequest,
  resolveEventFields,
  resolveIp,
} from './requestContext';
export type { TrackOptions } from './track';
export { track } from './track';
