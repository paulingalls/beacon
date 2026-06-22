// Trusted client-relay identify (execution_plan.json §Milestone 7, INTEGRATION.md
// "Linking the anonymous trail to a user on login"). The login-moment sibling of the
// ingest relay: when a user logs in, a product backend relays {visitor_token, user_id}
// to the deployed Beacon's `POST {basePath}/identify` under the M2 trusted bearer, so
// Beacon back-fills the earlier anonymous trail with the real user. A cross-origin
// browser can't carry the host's session to Beacon, so this is server-relayed and the
// secret lives on the backend. The bearer token is NEVER logged.
//
// Two seams (mirroring ingestRelay): relayIdentify (the Request-free primitive) and
// createIdentifyRelay (the framework-agnostic Request -> Response handler). Both share
// the trusted-forward contract in ./result.

import { forwardJson, type RelayResult, resultToResponse } from './result';

export interface RelayIdentifyOptions {
  /** Full identify URL, e.g. https://beacon.example/analytics/identify. */
  endpoint: string;
  /** M2 trusted-ingest bearer secret. Sent as `Authorization: Bearer`; never logged. */
  trustedIngestToken: string;
  /** fetch implementation; injectable for tests. Default globalThis.fetch. */
  fetch?: typeof fetch;
}

export interface IdentifyRelayOptions {
  endpoint: string;
  trustedIngestToken: string;
  /**
   * Resolve the authenticated user id from the inbound login request (the host owns
   * device->backend auth). Identify requires a user — a null/empty result is rejected
   * (400), unlike ingest which forwards anonymously. May be sync or async.
   */
  resolveUserId: (request: Request) => string | null | Promise<string | null>;
  fetch?: typeof fetch;
}

/**
 * Relay one login association to the trusted identify endpoint. Forward-and-await; fails
 * closed (throws) if the trusted token is unset. The token never appears in a thrown
 * message or a log.
 */
export function relayIdentify(
  params: { visitorToken: string; userId: string },
  opts: RelayIdentifyOptions,
): Promise<RelayResult> {
  return forwardJson(
    opts.endpoint,
    opts.trustedIngestToken,
    { visitor_token: params.visitorToken, user_id: params.userId },
    opts.fetch,
    'relayIdentify',
  );
}

/**
 * Build a framework-agnostic `Request -> Response` identify-relay handler. Mount it on an
 * authenticated backend login route. Fails fast at construction when the trusted token is
 * unset. Per request: read the device's `visitor_token` from the body, resolve the authed
 * user, and relay {visitor_token, user_id}. Both are required — a missing visitor_token or
 * an unresolved user yields 400 (no forward). Maps the relay result via resultToResponse
 * (204 ok, 400 caller-fault, 502 retryable); fail-closed throw -> 500.
 */
export function createIdentifyRelay(
  opts: IdentifyRelayOptions,
): (request: Request) => Promise<Response> {
  if (!opts.trustedIngestToken) {
    throw new Error('[beacon] createIdentifyRelay: trustedIngestToken is required (fail-closed)');
  }

  return async (request: Request): Promise<Response> => {
    let visitorToken: string;
    try {
      const parsed = (await request.json()) as unknown;
      const raw = (parsed as { visitor_token?: unknown } | null)?.visitor_token;
      if (typeof raw !== 'string') {
        return new Response(null, { status: 400 });
      }
      // Forward the same trimmed value we validated (validator/forwarder symmetry);
      // the server trims identically, so this only removes the asymmetry.
      visitorToken = raw.trim();
      if (visitorToken === '') {
        return new Response(null, { status: 400 });
      }
    } catch {
      return new Response(null, { status: 400 });
    }

    // The host owns resolveUserId; a throw there is its bug, not the device's. Isolate it
    // so the handler still returns a Response (never rejects), and never let its error reach
    // the caller — it may carry host internals. (mirrors apps/server ingest.ts getUserId guard)
    let userId: string | null;
    try {
      userId = await opts.resolveUserId(request);
    } catch (err) {
      console.warn(`[beacon] createIdentifyRelay: resolveUserId failed: ${String(err)}`);
      return new Response(null, { status: 500 });
    }
    // Identify needs a user to stitch the trail to — no anonymous path here.
    if (userId == null || userId === '') {
      return new Response(null, { status: 400 });
    }

    let result: RelayResult;
    try {
      result = await relayIdentify(
        { visitorToken, userId },
        { endpoint: opts.endpoint, trustedIngestToken: opts.trustedIngestToken, fetch: opts.fetch },
      );
    } catch {
      // Defense in depth: relayIdentify only throws fail-closed, which the constructor
      // already guards. Treat as a server misconfiguration. (no token in the response)
      return new Response(null, { status: 500 });
    }

    return resultToResponse(result);
  };
}
