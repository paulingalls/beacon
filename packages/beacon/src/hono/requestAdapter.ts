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
 * Adapt a Hono Context to a BeaconRequest. Each method delegates to `c.req.*`;
 * getToken/setToken proxy the `beaconVisitorToken` Context variable. clientAddress
 * inlines the guarded getConnInfo lookup (returns undefined off-server rather than
 * throwing). The mirrored guard in adapter/beaconRequest.ts is gone now that the
 * Hono adapter lives here, but defaultClientAddress (requestContext below) keeps an
 * intentionally identical copy for the Hono-Context socket source; keep the two in
 * sync if the guard changes (§1.1).
 */
export function honoToBeaconRequest(c: Context): BeaconRequest {
  return {
    header: (name) => c.req.header(name),
    query: (name) => c.req.query(name),
    url: c.req.url,
    path: c.req.path,
    method: c.req.method,
    json: () => c.req.json(),
    clientAddress: () => {
      try {
        return getConnInfo(c).remote.address;
      } catch {
        return undefined;
      }
    },
    getToken: () => c.get(VISITOR_TOKEN_KEY) ?? null,
    setToken: (token) => c.set(VISITOR_TOKEN_KEY, token),
  };
}
