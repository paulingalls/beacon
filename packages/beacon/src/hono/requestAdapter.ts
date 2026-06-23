import type { Context } from 'hono';
import { getConnInfo } from 'hono/bun';

import type { BeaconRequest } from '../adapter/beaconRequest';

// Hono-Context request adapter (REQUIREMENTS.md §1.1). Lives behind the ./hono
// subpath so the framework-agnostic emit path (createHttpBeacon) never loads
// hono/bun: requestToBeaconRequest stays in adapter/beaconRequest.ts (hono-free),
// while this Hono-only counterpart — the only thing that calls getConnInfo — is
// imported only by the deployed Hono host and by consumers that opt into /hono.

/** Visitor-token variable name (mirrors requestLogger's Hono ContextVariableMap key). */
const VISITOR_TOKEN_KEY = 'beaconVisitorToken';

/**
 * Bun socket address via getConnInfo, guarded — returns undefined off-server (e.g.
 * in tests, where getConnInfo throws) rather than propagating (§1.1). The single
 * home for the guard now that both Hono socket-address callers (honoToBeaconRequest
 * here and defaultClientAddress in requestContext) live in this ./hono module — no
 * import cycle to force a duplicated copy.
 */
export function socketAddress(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined;
  }
}

/**
 * Adapt a Hono Context to a BeaconRequest. Each method delegates to `c.req.*`;
 * getToken/setToken proxy the `beaconVisitorToken` Context variable. clientAddress
 * resolves the guarded Bun socket address via socketAddress (undefined off-server).
 */
export function honoToBeaconRequest(c: Context): BeaconRequest {
  return {
    header: (name) => c.req.header(name),
    query: (name) => c.req.query(name),
    url: c.req.url,
    path: c.req.path,
    method: c.req.method,
    json: () => c.req.json(),
    clientAddress: () => socketAddress(c),
    getToken: () => c.get(VISITOR_TOKEN_KEY) ?? null,
    setToken: (token) => c.set(VISITOR_TOKEN_KEY, token),
  };
}
