// Trusted client-relay ingest (execution_plan.json §Milestone 7, INTEGRATION.md
// "Associating a logged-in user"). A product backend points a beacon-client device's
// `endpoint` at this relay instead of at Beacon directly. The relay receives the
// device's anonymous batch, resolves the authenticated user_id via a host callback,
// stamps it on each event, and forwards the batch to the deployed Beacon's
// `POST {basePath}/events` under the M2 trusted bearer — so the secret lives on the
// backend, never on the distributed-binary device. The bearer token is NEVER logged.
//
// Two seams:
//   relayBatch        — the primitive: forward an already-parsed batch + a resolved
//                       user_id, returning a retry-shaped result (no Request/Response).
//   createIngestRelay — a framework-agnostic Request -> Response handler that resolves
//                       the user, calls relayBatch, and maps the result to a status the
//                       device's HttpSink can act on (retry vs drop).
//
// The trusted-forward contract (fail-closed POST + outcome classification + response
// mapping) lives in ./result so this relay and the identify relay can never drift.

import { forwardJson, type RelayResult, resultToResponse } from './result';

export type { RelayResult } from './result';

/** The wire envelope a beacon-client device POSTs (core/client.ts buildBody). */
export interface ClientBatch {
  product_id?: string;
  visitor_token?: string;
  events: unknown[];
}

export interface RelayBatchOptions {
  /** Full ingest URL to forward to, e.g. https://beacon.example/analytics/events. */
  endpoint: string;
  /** M2 trusted-ingest bearer secret. Sent as `Authorization: Bearer`; never logged. */
  trustedIngestToken: string;
  /** Host-resolved authenticated user id, or null to forward anonymously. */
  userId: string | null;
  /** fetch implementation; injectable for tests. Default globalThis.fetch. */
  fetch?: typeof fetch;
}

export interface IngestRelayOptions {
  endpoint: string;
  trustedIngestToken: string;
  /**
   * Resolve the authenticated user id from the inbound request (the host owns
   * device->backend auth). Return null when there is no logged-in user — the batch
   * then forwards anonymously. May be sync or async.
   */
  resolveUserId: (request: Request) => string | null | Promise<string | null>;
  fetch?: typeof fetch;
}

/**
 * Stamp the resolved user_id onto one event, stripping any device-asserted user_id
 * first so a client can never smuggle an identity over the trusted bearer. Non-object
 * events pass through untouched (ingest skips invalid events server-side).
 */
function stampUser(event: unknown, userId: string | null): unknown {
  if (typeof event !== 'object' || event === null) return event;
  const { user_id: _drop, ...rest } = event as Record<string, unknown>;
  return userId != null ? { ...rest, user_id: userId } : rest;
}

/**
 * Forward a parsed client batch to the trusted ingest endpoint, attributing each event
 * to `userId`. Forward-and-await (not fire-and-forget): the caller gets a real result.
 * Fails closed — throws if the trusted token is unset, never forwarding a resolved user
 * over an unauthenticated path. The token never appears in a thrown message or a log.
 */
export function relayBatch(batch: ClientBatch, opts: RelayBatchOptions): Promise<RelayResult> {
  const body: Record<string, unknown> = {
    // Omit empty/falsy product_id and visitor_token rather than forward them: an empty
    // product_id is invalid server-side and, under a configured allowlist, a PRESENT-
    // but-invalid product_id rejects the whole batch (403) — which would drop valid
    // events, the one thing this relay must never do. Omitting lets ingest fall back to
    // its configured product. (An empty visitor_token is likewise skip-not-reject.)
    ...(batch.product_id ? { product_id: batch.product_id } : {}),
    ...(batch.visitor_token ? { visitor_token: batch.visitor_token } : {}),
    events: batch.events.map((e) => stampUser(e, opts.userId)),
  };
  return forwardJson(opts.endpoint, opts.trustedIngestToken, body, opts.fetch, 'relayBatch');
}

/**
 * Build a framework-agnostic `Request -> Response` relay handler. Mount it on an
 * authenticated backend route and point your devices' BeaconClient `endpoint` at it.
 * Fails fast at construction when the trusted token is unset (a misconfigured relay
 * never builds). Per request: parse the batch, resolve the user, forward, and map the
 * result to a status the device's HttpSink acts on — 204 ok, 400 device-fault (drop),
 * 502 retryable (the device retries).
 */
export function createIngestRelay(
  opts: IngestRelayOptions,
): (request: Request) => Promise<Response> {
  if (!opts.trustedIngestToken) {
    throw new Error('[beacon] createIngestRelay: trustedIngestToken is required (fail-closed)');
  }

  return async (request: Request): Promise<Response> => {
    let batch: ClientBatch;
    try {
      const parsed = (await request.json()) as unknown;
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !Array.isArray((parsed as ClientBatch).events)
      ) {
        return new Response(null, { status: 400 });
      }
      batch = parsed as ClientBatch;
    } catch {
      return new Response(null, { status: 400 });
    }

    const userId = await opts.resolveUserId(request);

    let result: RelayResult;
    try {
      result = await relayBatch(batch, {
        endpoint: opts.endpoint,
        trustedIngestToken: opts.trustedIngestToken,
        userId,
        fetch: opts.fetch,
      });
    } catch {
      // Defense in depth: relayBatch only throws fail-closed, which the constructor
      // already guards. Treat as a server misconfiguration. (no token in the response)
      return new Response(null, { status: 500 });
    }

    return resultToResponse(result);
  };
}
