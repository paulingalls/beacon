import { Buffer } from 'node:buffer';

import type { Context, Handler } from 'hono';

import type { EventSink } from '../events/sink';
import {
  buildEventContext,
  defaultClientAddress,
  hashIp,
  resolveIp,
} from '../middleware/requestContext';
import type { BeaconEvent } from '../types';
import { verifyTrustedBearer } from './auth';
import { errorResponse } from './errors';
import { applyRateLimit, RateLimiter } from './rateLimit';

// Client batch ingest endpoint (REQUIREMENTS.md §6.2 / PHASE_4 §4.2). The mobile
// SDK POSTs {events:[...]} here; valid events are buffered fire-and-forget. The
// endpoint is public but rate-limited per caller. Invalid individual events are
// skipped (not rejected) so one bad event doesn't drop a whole batch.

const MAX_EVENTS_PER_REQUEST = 100;
const MAX_EVENT_TYPE_LENGTH = 100;
const MAX_PRODUCT_ID_LENGTH = 100;
const MAX_VISITOR_TOKEN_LENGTH = 100;
const MAX_USER_ID_LENGTH = 100;
const MAX_PROPERTIES_BYTES = 10 * 1024;
const MAX_CONTEXT_BYTES = 10 * 1024;
const DEFAULT_RATE_LIMIT = 10;
const DEFAULT_RATE_WINDOW_MS = 60_000;

export interface IngestOptions {
  /** Product this Beacon instance logs for (beacon_events.product_id). */
  productId: string;
  /**
   * Opt-in allowlist of accepted product_ids (story-006). When set, a present
   * non-allowlisted body.product_id rejects the batch (403); when unset, any
   * product_id is accepted. See BeaconConfig.productAllowlist.
   */
  productAllowlist?: string[];
  /** Resolve the authenticated user id from the request, or null. */
  getUserId?: (c: Context) => string | null;
  /**
   * Shared secret authorizing a trusted server-to-server caller to assert per-event
   * user_id + context in the batch body (M2). When unset, trusted ingest is disabled
   * (fail-closed): body user_id/context are ignored and the public anonymous path is
   * unchanged. Compared in constant time via verifyTrustedBearer; never logged.
   */
  trustedIngestToken?: string;
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
  /** Per-event identity, honored only under a verified trusted bearer (M2). */
  user_id?: unknown;
  context?: unknown;
}

/**
 * Build the `POST /events` handler (REQUIREMENTS.md §6.2). The factory owns a
 * single RateLimiter so the sliding window persists across requests. story-004
 * mounts the returned handler at `POST {basePath}/events`.
 */
export function createIngestHandler(buffer: EventSink, opts: IngestOptions): Handler {
  const limiter = new RateLimiter({
    limit: opts.rateLimit?.limit ?? DEFAULT_RATE_LIMIT,
    windowMs: opts.rateLimit?.windowMs ?? DEFAULT_RATE_WINDOW_MS,
    now: opts.rateLimit?.now,
  });

  return async (c) => {
    // Resolve ONLY the rate-limit key before the gate — user id and ip are cheap
    // and body-free. The transport context (which JSON-parses the attacker-
    // controlled X-App-Context header) is deliberately deferred until after the
    // gate passes, so an over-limit caller is rejected without that parse work.
    let userId: string | null = null;
    try {
      userId = opts.getUserId?.(c) ?? null;
    } catch (err) {
      console.warn(`[beacon] ingest: getUserId failed: ${String(err)}`);
    }
    const hashIPs = opts.hashIPs ?? true;
    const ip = resolveIp(c, hashIPs, opts.getClientAddress ?? defaultClientAddress);
    const identifier = userId ?? ip ?? 'unknown'; // per-user when authed, else per-IP (§6.2)

    // Check BEFORE parsing the body so an over-limit caller is rejected without us
    // reading a (possibly large) body.
    const denied = applyRateLimit(c, limiter, identifier, 'rate limit exceeded; retry later');
    if (denied) return denied;

    // Past the gate: now build the transport context + platform (shared by every
    // event in this batch) and read the visitor token the middleware put on c.
    // This transport token (minted from the URL `_t` param) is the FALLBACK; a
    // body-carried visitor_token (the SPA's only carrier) overrides it below.
    const transportVisitorToken = c.get('beaconVisitorToken') ?? null;
    const { context, platform } = buildEventContext(c, ip);

    // Trusted-caller gate (M2): only a verified bearer may assert per-event user_id
    // + context below. An untrusted/absent/misconfigured caller resolves to false
    // (fail-closed), leaving the public anonymous path identical to before.
    const trusted = verifyTrustedBearer(c.req.header('authorization'), opts.trustedIngestToken);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 'INVALID_PARAMETER', 'request body must be valid JSON', 'body');
    }

    // Single cast of the request body to its known shape — add new top-level
    // fields here so the envelope is read in one place. (visitor_token is the
    // anonymous SPA handle; a body user_id is deliberately NOT read — authenticated
    // identity stays gated behind trusted bearer auth, M2.)
    const { events, product_id, visitor_token } = (body ?? {}) as {
      events?: unknown;
      product_id?: unknown;
      visitor_token?: unknown;
    };
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

    const resolvedProductId = validShortString(product_id, MAX_PRODUCT_ID_LENGTH);

    // Strict allowlist mode (story-006): when an allowlist is configured, a PRESENT
    // body.product_id must resolve to an allowlisted value — else reject the whole
    // batch (403) and drop its events. This is the one place ingest rejects, and it
    // never loses VALID events: a correctly-configured client always sends an
    // allowlisted id; only a spoofed/typo'd claim is dropped, with a loud signal so
    // a misconfigured product is caught fast (concerns 5cd718796d70, 5966333732ba).
    // An absent product_id is unaffected — it defaults to opts.productId below
    // (createBeacon guarantees opts.productId is itself allowlisted).
    if (
      opts.productAllowlist !== undefined &&
      product_id !== undefined &&
      (resolvedProductId === null || !opts.productAllowlist.includes(resolvedProductId))
    ) {
      console.warn(
        `[beacon] ingest: rejected batch — body.product_id ${JSON.stringify(product_id)} is not an allowed product; dropped ${events.length} event(s)`,
      );
      return errorResponse(
        c,
        'UNAUTHORIZED',
        'body.product_id is not in the configured allowlist',
        'product_id',
      );
    }

    // The batch product is the SDK's body.product_id when valid (shared multi-
    // product ingest), else this instance's configured product — outside allowlist
    // mode an invalid value never rejects the batch (skip-not-reject). A present-
    // but-invalid value is logged as a misconfiguration signal; an absent product_id
    // is the normal web default-to-configured case, so it stays quiet (no log spam).
    // Either way the resolved product is echoed back as product_id_used so a caller
    // can detect its events were attributed to a different product than intended
    // (concern 627bc47710fd).
    const productId = resolvedProductId ?? opts.productId;
    if (resolvedProductId === null && product_id !== undefined) {
      console.warn(
        `[beacon] ingest: invalid body.product_id ${JSON.stringify(product_id)} — using configured '${opts.productId}'`,
      );
    }

    // Resolve the batch's anonymous visitor token (story-001): a valid body
    // visitor_token wins; the transport token (URL `_t`) is the fallback; an
    // invalid value (non-string / empty / over-length) is treated as absent so
    // the batch is never rejected over it (skip-not-reject, like product_id).
    // Unlike an invalid product_id, an invalid visitor_token is INTENTIONALLY
    // silent (no warn): it's anonymous, ephemeral, and arrives from untrusted
    // high-volume public callers, so a malformed value is expected noise — not a
    // misconfiguration signal — and warning on it would only invite log-spam.
    const visitorToken =
      validShortString(visitor_token, MAX_VISITOR_TOKEN_LENGTH) ?? transportVisitorToken;

    // Transport context + platform are the same for every event in this request
    // (resolved once above, after the rate-limit gate passed).
    const shared: SharedEventFields = {
      productId,
      userId,
      visitorToken,
      platform,
      context,
    };

    let accepted = 0;
    for (const raw of events as RawEvent[]) {
      const event = toEvent(raw, shared, trusted, hashIPs);
      if (event) {
        buffer.push(event);
        accepted += 1;
      }
    }
    return c.json({ accepted, product_id_used: productId }, 202);
  };
}

/**
 * Validate one raw event and build a BeaconEvent, or return null to skip it
 * (§6.2: invalid events are skipped, not rejected). event_type must be a
 * non-empty string ≤100 chars (stored trimmed); properties, if present, must be
 * a plain object ≤10KB serialized; timestamp, if a valid date string, is the
 * event time, else it defaults to the server ingest time at flush.
 */
function toEvent(
  raw: RawEvent,
  shared: SharedEventFields,
  trusted: boolean,
  hashIPs: boolean,
): BeaconEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;

  const eventType = validShortString(raw.event_type, MAX_EVENT_TYPE_LENGTH);
  if (eventType === null) return null;

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

  // Per-event identity (M2): only under verified trust does the body's user_id +
  // context override the transport-resolved shared values; otherwise the anonymous
  // public path is unchanged. An invalid value falls back to the shared default
  // (skip-not-reject) — a malformed identity never drops the event.
  const userId = trusted
    ? (validShortString(raw.user_id, MAX_USER_ID_LENGTH) ?? shared.userId)
    : shared.userId;
  const context = trusted
    ? resolveTrustedContext(raw.context, shared.context, hashIPs)
    : shared.context;

  const timestamp = parseTimestamp(raw.timestamp);
  return {
    productId: shared.productId,
    eventType,
    ...(timestamp ? { timestamp } : {}),
    userId,
    visitorToken: shared.visitorToken,
    platform: shared.platform,
    properties,
    context,
  };
}

/**
 * Resolve a trusted caller's per-event `context` (M2). A valid plain object within
 * the size cap REPLACES the transport context for that event (so a relay's own
 * ip/user-agent never leak onto end-user events), with `ip` always hashed per the
 * never-store-raw-IP rule. An invalid/oversized/absent value falls back to the
 * transport context (skip-not-reject).
 */
function resolveTrustedContext(
  raw: unknown,
  fallback: Record<string, unknown>,
  hashIPs: boolean,
): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fallback;
  if (Buffer.byteLength(JSON.stringify(raw), 'utf8') > MAX_CONTEXT_BYTES) return fallback;
  const ctx = raw as Record<string, unknown>;
  const ip = typeof ctx.ip === 'string' ? ctx.ip : undefined;
  return { ...ctx, ip: hashIp(ip, hashIPs) };
}

/**
 * Shared shape rule for short identifier fields (event_type, product_id):
 * a non-empty trimmed string ≤ maxLength, else null so the caller can skip
 * the event or fall back (never rejects the batch).
 */
function validShortString(raw: unknown, maxLength: number): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value === '' || value.length > maxLength) return null;
  return value;
}

/** Parse an optional ISO timestamp; undefined when absent or unparseable. */
function parseTimestamp(value: unknown): Date | undefined {
  if (typeof value !== 'string') return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
