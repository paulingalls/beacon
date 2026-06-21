import type { Context } from 'hono';

import { resolveEventFields } from '../middleware/requestContext';
import type { EventSink } from './sink';

/** Max event_type length (REQUIREMENTS.md §6.1). */
const MAX_EVENT_TYPE_LENGTH = 100;

/** Config the track() helper needs, injected by createBeacon() (REQUIREMENTS.md §6.1). */
export interface TrackOptions {
  /** Product this Beacon instance logs for (beacon_events.product_id). */
  productId: string;
  /** Resolve the authenticated user id from the request, or null. */
  getUserId?: (c: Context) => string | null;
  /** SHA-256 the client IP before storage (REQUIREMENTS.md §1.1). Default true. */
  hashIPs?: boolean;
  /** Socket-address source when X-Forwarded-For is absent. Defaults to Bun's getConnInfo. */
  getClientAddress?: (c: Context) => string | undefined;
}

/**
 * Record a custom product event from a route handler (REQUIREMENTS.md §6.1).
 *
 * Reads user_id via getUserId and the visitor token + transport context the
 * request-logging middleware populated, builds a `<eventType>` event with the
 * given properties (defaulting to `{}` when omitted), and pushes it to the
 * shared EventBuffer. Fire-and-forget: returns void without awaiting — the
 * buffer flushes asynchronously.
 *
 * Throws only on an invalid event_type (empty/whitespace or >100 chars) — the
 * one intentional throw, validated before any side effect so nothing is pushed.
 * A throwing getUserId is swallowed (user_id → null) so a host auth failure can
 * never crash track() (§1.3 failure isolation).
 *
 * Callers run downstream of beacon.middleware(); off-path or authenticated calls
 * simply yield a null visitor token.
 */
export function track(
  buffer: EventSink,
  c: Context,
  opts: TrackOptions,
  eventType: string,
  properties?: Record<string, unknown>,
): void {
  // Validate and store the trimmed value so the emptiness check and the length
  // cap measure the same string the event carries — no whitespace-padded types.
  const trimmedEventType = eventType.trim();
  if (trimmedEventType === '' || trimmedEventType.length > MAX_EVENT_TYPE_LENGTH) {
    throw new Error(
      `[beacon] track: event_type must be a non-empty string of at most ${MAX_EVENT_TYPE_LENGTH} characters`,
    );
  }

  const { userId, visitorToken, platform, context } = resolveEventFields(c, {
    getUserId: opts.getUserId,
    hashIPs: opts.hashIPs,
    getClientAddress: opts.getClientAddress,
    label: 'track',
  });

  buffer.push({
    productId: opts.productId,
    eventType: trimmedEventType,
    // Event time stamped at call time (client/event time), distinct from
    // received_at (server ingest time set by the column DEFAULT at flush).
    timestamp: new Date(),
    userId,
    visitorToken,
    platform,
    properties: properties ?? {},
    context,
  });
}
