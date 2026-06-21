import type { Context } from 'hono';
import { getConnInfo } from 'hono/bun';

// Framework-agnostic request adapter (execution_plan.json §Milestone 3). The
// event-capture layer (requestContext/requestLogger/track/ingest) reads request
// metadata through Hono's Context today; BeaconRequest is the minimal surface it
// actually needs, so the same capture logic can run under Bun.serve — which has
// no Context and no per-request variable bag — while the deployed Hono host stays
// byte-identical via honoToBeaconRequest. story-002 refactors capture onto this;
// story-003's framework-agnostic factory + HttpSink consume it.
//
// Response writes (c.json / c.res.status / redirects) are deliberately NOT here —
// they stay on the Hono Context in the handlers. Only the read surface that builds
// an event, plus the visitor-token get/set, is abstracted.

/** The minimal request surface the event-capture layer reads. */
export interface BeaconRequest {
  /** Case-insensitive header lookup; undefined when absent (matches Hono). */
  header(name: string): string | undefined;
  /** Query-param lookup; undefined when absent. */
  query(name: string): string | undefined;
  /** Full request URL (attribution extraction). */
  url: string;
  /** Request path (excludePaths matching, request-event property). */
  path: string;
  /** HTTP method (request-event property). */
  method: string;
  /** Parse the request body as JSON (ingest). */
  json(): Promise<unknown>;
  /**
   * Client socket address only — the x-forwarded-for header is still read via
   * header() in resolveIp, so IP precedence is unchanged. Undefined when no
   * source yields an address; never throws.
   */
  clientAddress(): string | undefined;
  /** Current visitor token (beaconVisitorToken), or null. */
  getToken(): string | null;
  /** Set the visitor token (beaconVisitorToken). */
  setToken(token: string): void;
}

/** Visitor-token variable name (mirrors requestLogger's Hono ContextVariableMap key). */
const VISITOR_TOKEN_KEY = 'beaconVisitorToken';

/**
 * Adapt a Hono Context to a BeaconRequest. Each method delegates to `c.req.*`;
 * getToken/setToken proxy the `beaconVisitorToken` Context variable; clientAddress
 * reuses the guarded getConnInfo lookup (returns undefined off-server rather than
 * throwing — the current defaultClientAddress behavior, §1.1).
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

/**
 * Adapt a plain Web Request to a BeaconRequest, for a Bun.serve host. The socket
 * address has no standard place on a Request, so the host injects it (Bun:
 * `server.requestIP(req)?.address`). A plain Request has no variable bag, so the
 * visitor token is held in a closure for the lifetime of this adapter — the
 * capture path sets it and the caller reads it back via getToken().
 */
export function requestToBeaconRequest(
  request: Request,
  opts?: { clientAddress?: string },
): BeaconRequest {
  const parsed = new URL(request.url);
  let token: string | null = null;
  return {
    header: (name) => request.headers.get(name) ?? undefined,
    query: (name) => parsed.searchParams.get(name) ?? undefined,
    url: request.url,
    path: parsed.pathname,
    method: request.method,
    json: () => request.json(),
    clientAddress: () => opts?.clientAddress,
    getToken: () => token,
    setToken: (value) => {
      token = value;
    },
  };
}
