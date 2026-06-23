// Framework-agnostic request adapter (REQUIREMENTS.md §1.1 request-metadata/
// transport-context). The event-capture layer (requestContext/track/ingest) reads
// request metadata through this minimal surface, so the same capture logic runs
// under Bun.serve — which has no Context and no per-request variable bag — and under
// the deployed Hono host. The Hono-Context counterpart (honoToBeaconRequest) lives
// behind the ./hono subpath (src/hono/requestAdapter.ts) so this module — and the
// createHttpBeacon graph that imports requestToBeaconRequest — loads zero hono.
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
  // A Web Request body is a one-shot stream: a second request.json() throws
  // "Body already read". Hono's c.req.json() memoizes, so cache the parse Promise
  // here to keep json() callable more than once and identical across transports.
  let bodyPromise: Promise<unknown> | undefined;
  return {
    header: (name) => request.headers.get(name) ?? undefined,
    query: (name) => parsed.searchParams.get(name) ?? undefined,
    url: request.url,
    path: parsed.pathname,
    method: request.method,
    json: () => (bodyPromise ??= request.json()),
    clientAddress: () => opts?.clientAddress,
    getToken: () => token,
    setToken: (value) => {
      token = value;
    },
  };
}
