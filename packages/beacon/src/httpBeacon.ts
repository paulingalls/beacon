import { requestToBeaconRequest } from './adapter/beaconRequest';
import { HttpSink } from './events/httpSink';
import { MAX_EVENT_TYPE_LENGTH } from './events/limits';
import { resolveEventFieldsFromRequest } from './middleware/requestContext';
import type { BufferStats } from './types';

// Framework-agnostic Beacon factory (execution_plan.json §Milestone 3). The
// Bun.serve counterpart to createBeacon: it composes the request adapter + the
// BeaconRequest capture cores + an HttpSink so a product running under any runtime
// (no Hono, no Postgres) captures requests and custom events and emits them over
// the M2 trusted ingest boundary. The deployed Beacon stays the only holder of
// central-DB write credentials (HTTP single-writer).
//
// MAX_EVENT_TYPE_LENGTH is imported from events/limits.ts so the event_type cap
// is identical across the Hono track() and this HTTP factory (REQUIREMENTS.md §6.1).

export interface HttpBeaconOptions {
  /** Product this instance emits for (beacon_events.product_id). */
  productId: string;
  /** Deployed Beacon ingest URL, e.g. https://beacon.example/analytics/events. */
  endpoint: string;
  /** M2 trusted-ingest bearer secret; sent as Authorization: Bearer, never logged. */
  trustedIngestToken: string;
  /**
   * Resolve the authenticated user id from the request, or null. Request-based
   * (not a Hono Context) — under Bun.serve there is no Context. A throw is isolated
   * to a null user id (§1.3). Per-event user_id is honored by ingest under the bearer.
   */
  getUserId?: (request: Request) => string | null;
  /** SHA-256 the client IP before it leaves the product. Default true. */
  hashIPs?: boolean;
  /** HttpSink tuning (see HttpSinkOptions). */
  flushInterval?: number;
  maxBatchSize?: number;
  maxBufferSize?: number;
  maxRetries?: number;
  /** fetch implementation; injectable for tests. Default globalThis.fetch. */
  fetch?: typeof fetch;
}

/** A configured framework-agnostic Beacon: capture requests + custom events, emit over HTTP. */
export interface HttpBeacon {
  /**
   * Log a `request` event for an incoming request. `status`/`responseTimeMs` are
   * supplied by the host (Bun.serve has no middleware chain to observe the response);
   * `clientAddress` is the host's socket address (e.g. Bun `server.requestIP(req)?.address`).
   */
  capture(
    request: Request,
    opts?: { clientAddress?: string; status?: number; responseTimeMs?: number },
  ): void;
  /**
   * Record a custom product event. Throws only on an invalid event_type
   * (empty/whitespace or >100 chars). Fire-and-forget otherwise.
   */
  track(
    request: Request,
    eventType: string,
    properties?: Record<string, unknown>,
    opts?: { clientAddress?: string },
  ): void;
  /** Flush one batch to the ingest endpoint now. */
  flush(): Promise<void>;
  /** Current sink counters. */
  stats(): BufferStats;
  /** Drain remaining events and stop the flush timer. */
  shutdown(): Promise<void>;
}

/**
 * Create a framework-agnostic Beacon backed by an HttpSink. The sink's flush timer
 * starts immediately; the host calls shutdown() to drain on exit.
 */
export function createHttpBeacon(opts: HttpBeaconOptions): HttpBeacon {
  if (!opts.productId) throw new Error('[beacon] httpBeacon: productId is required');
  if (!opts.endpoint) throw new Error('[beacon] httpBeacon: endpoint is required');
  if (!opts.trustedIngestToken) {
    throw new Error('[beacon] httpBeacon: trustedIngestToken is required');
  }

  const sink = new HttpSink({
    endpoint: opts.endpoint,
    trustedIngestToken: opts.trustedIngestToken,
    productId: opts.productId,
    flushInterval: opts.flushInterval,
    maxBatchSize: opts.maxBatchSize,
    maxBufferSize: opts.maxBufferSize,
    maxRetries: opts.maxRetries,
    fetch: opts.fetch,
  });
  sink.start();

  // Build the BeaconRequest once per call: thread the host socket address, adopt the
  // `_t` query param as the visitor handle (the deployed Beacon owns minting; a
  // product only forwards), and resolve userId via the host callback (§1.3 isolated).
  const prepare = (request: Request, clientAddress: string | undefined) => {
    const req = requestToBeaconRequest(request, { clientAddress });
    const t = req.query('_t');
    if (t) req.setToken(t);
    let userId: string | null = null;
    try {
      userId = opts.getUserId?.(request) ?? null;
    } catch (err) {
      console.warn(`[beacon] httpBeacon: getUserId failed: ${String(err)}`);
    }
    const fields = resolveEventFieldsFromRequest(req, { userId, hashIPs: opts.hashIPs });
    return { req, fields };
  };

  return {
    capture: (request, captureOpts) => {
      const { req, fields } = prepare(request, captureOpts?.clientAddress);
      sink.push({
        productId: opts.productId,
        eventType: 'request',
        timestamp: new Date(),
        userId: fields.userId,
        visitorToken: fields.visitorToken,
        platform: fields.platform,
        properties: {
          path: req.path,
          method: req.method,
          ...(captureOpts?.status !== undefined ? { status: captureOpts.status } : {}),
          ...(captureOpts?.responseTimeMs !== undefined
            ? { response_time_ms: captureOpts.responseTimeMs }
            : {}),
        },
        context: fields.context,
      });
    },

    track: (request, eventType, properties, trackOpts) => {
      const trimmed = eventType.trim();
      if (trimmed === '' || trimmed.length > MAX_EVENT_TYPE_LENGTH) {
        throw new Error(
          `[beacon] httpBeacon.track: event_type must be a non-empty string of at most ${MAX_EVENT_TYPE_LENGTH} characters`,
        );
      }
      const { fields } = prepare(request, trackOpts?.clientAddress);
      sink.push({
        productId: opts.productId,
        eventType: trimmed,
        timestamp: new Date(),
        userId: fields.userId,
        visitorToken: fields.visitorToken,
        platform: fields.platform,
        properties: properties ?? {},
        context: fields.context,
      });
    },

    flush: () => sink.flush(),
    stats: () => sink.stats(),
    shutdown: () => sink.stop(),
  };
}
