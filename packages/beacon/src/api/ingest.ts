import { Buffer } from 'node:buffer';

import type { Context, Handler } from 'hono';

import type { EventBuffer } from '../events/buffer';
import { buildEventContext, defaultClientAddress, resolveIp } from '../middleware/requestContext';
import type { BeaconEvent } from '../types';
import { errorResponse } from './errors';
import { RateLimiter } from './rateLimit';

// Client batch ingest endpoint (REQUIREMENTS.md §6.2 / PHASE_4 §4.2). The mobile
// SDK POSTs {events:[...]} here; valid events are buffered fire-and-forget. The
// endpoint is public but rate-limited per caller. Invalid individual events are
// skipped (not rejected) so one bad event doesn't drop a whole batch.

const MAX_EVENTS_PER_REQUEST = 100;
const MAX_EVENT_TYPE_LENGTH = 100;
const MAX_PROPERTIES_BYTES = 10 * 1024;
const DEFAULT_RATE_LIMIT = 10;
const DEFAULT_RATE_WINDOW_MS = 60_000;

export interface IngestOptions {
  /** Product this Beacon instance logs for (beacon_events.product_id). */
  productId: string;
  /** Resolve the authenticated user id from the request, or null. */
  getUserId?: (c: Context) => string | null;
  /** SHA-256 the client IP before storage / rate-limit keying. Default true. */
  hashIPs?: boolean;
  /** Socket-address source when X-Forwarded-For is absent. Default Bun's getConnInfo. */
  getClientAddress?: (c: Context) => string | undefined;
  /** Rate-limit tuning. Default 10 requests per 60s per identifier (§6.2). */
  rateLimit?: { limit?: number; windowMs?: number; now?: () => number };
}

/** Fields shared by every event in one batch (resolved once per request). */
interface SharedEventFields {
  productId: string;
  userId: string | null;
  visitorToken: string | null;
  platform: string;
  context: Record<string, unknown>;
}

interface RawEvent {
  event_type?: unknown;
  properties?: unknown;
  timestamp?: unknown;
}

/**
 * Build the `POST /events` handler (REQUIREMENTS.md §6.2). The factory owns a
 * single RateLimiter so the sliding window persists across requests. story-004
 * mounts the returned handler at `POST {basePath}/events`.
 */
export function createIngestHandler(buffer: EventBuffer, opts: IngestOptions): Handler {
  const limiter = new RateLimiter({
    limit: opts.rateLimit?.limit ?? DEFAULT_RATE_LIMIT,
    windowMs: opts.rateLimit?.windowMs ?? DEFAULT_RATE_WINDOW_MS,
    now: opts.rateLimit?.now,
  });
  const hashIPs = opts.hashIPs ?? true;
  const getClientAddress = opts.getClientAddress ?? defaultClientAddress;

  return async (c) => {
    // Resolve the rate-limit identifier and check it BEFORE parsing the body, so
    // an over-limit caller is rejected without us reading a (possibly large) body.
    // getUserId is host-supplied — a throw must not crash the host (§1.3).
    let userId: string | null = null;
    try {
      userId = opts.getUserId?.(c) ?? null;
    } catch (err) {
      console.warn(`[beacon] ingest: getUserId failed: ${String(err)}`);
    }
    const ip = resolveIp(c, hashIPs, getClientAddress);
    const identifier = userId ?? ip ?? 'unknown'; // per-user when authed, else per-IP (§6.2)

    const { allowed, retryAfter } = limiter.check(identifier);
    if (!allowed) {
      c.header('Retry-After', String(retryAfter));
      return errorResponse(c, 'RATE_LIMITED', 'rate limit exceeded; retry later');
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 'INVALID_PARAMETER', 'request body must be valid JSON', 'body');
    }

    const events = (body as { events?: unknown } | null)?.events;
    if (events === undefined) {
      return errorResponse(c, 'MISSING_PARAMETER', "missing 'events' array", 'events');
    }
    if (!Array.isArray(events)) {
      return errorResponse(c, 'INVALID_PARAMETER', "'events' must be an array", 'events');
    }
    if (events.length > MAX_EVENTS_PER_REQUEST) {
      return errorResponse(
        c,
        'INVALID_PARAMETER',
        `at most ${MAX_EVENTS_PER_REQUEST} events per request`,
        'events',
      );
    }

    // Transport context + platform are the same for every event in this request.
    const { context, platform } = buildEventContext(c, ip);
    const shared: SharedEventFields = {
      productId: opts.productId,
      userId,
      visitorToken: c.get('beaconVisitorToken') ?? null,
      platform,
      context,
    };

    let accepted = 0;
    for (const raw of events as RawEvent[]) {
      const event = toEvent(raw, shared);
      if (event) {
        buffer.push(event);
        accepted += 1;
      }
    }
    return c.json({ accepted }, 202);
  };
}

/**
 * Validate one raw event and build a BeaconEvent, or return null to skip it
 * (§6.2: invalid events are skipped, not rejected). event_type must be a
 * non-empty string ≤100 chars (stored trimmed); properties, if present, must be
 * a plain object ≤10KB serialized; timestamp, if a valid date string, is the
 * event time, else it defaults to the server ingest time at flush.
 */
function toEvent(raw: RawEvent, shared: SharedEventFields): BeaconEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;

  if (typeof raw.event_type !== 'string') return null;
  const eventType = raw.event_type.trim();
  if (eventType === '' || eventType.length > MAX_EVENT_TYPE_LENGTH) return null;

  let properties: Record<string, unknown> = {};
  if (raw.properties !== undefined) {
    if (
      typeof raw.properties !== 'object' ||
      raw.properties === null ||
      Array.isArray(raw.properties)
    ) {
      return null;
    }
    if (Buffer.byteLength(JSON.stringify(raw.properties), 'utf8') > MAX_PROPERTIES_BYTES)
      return null;
    // Narrowed to a non-null, non-array object by the guard above.
    properties = raw.properties as Record<string, unknown>;
  }

  const timestamp = parseTimestamp(raw.timestamp);
  return {
    productId: shared.productId,
    eventType,
    ...(timestamp ? { timestamp } : {}),
    userId: shared.userId,
    visitorToken: shared.visitorToken,
    platform: shared.platform,
    properties,
    context: shared.context,
  };
}

/** Parse an optional ISO timestamp; undefined when absent or unparseable. */
function parseTimestamp(value: unknown): Date | undefined {
  if (typeof value !== 'string') return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
