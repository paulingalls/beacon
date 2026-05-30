import type { Context, MiddlewareHandler } from 'hono';

import type { EventBuffer } from '../events/buffer';
import type { BeaconEvent } from '../types';
import { extractAttribution } from '../visitors/attribution';
import type { VisitorTokenStore } from '../visitors/tokenStore';
import { buildEventContext, defaultClientAddress, resolveIp } from './requestContext';

// Expose the visitor token on the Hono context so the host app can read it
// (e.g. to append ?_t= to rendered links) via c.get('beaconVisitorToken').
// Optional: it is only set on the anonymous + token-store path, so authed and
// no-store requests leave it undefined.
declare module 'hono' {
  interface ContextVariableMap {
    beaconVisitorToken?: string;
  }
}

export interface RequestLoggerOptions {
  /** Product this Beacon instance logs for (beacon_events.product_id). */
  productId: string;
  /** Resolve the authenticated user id from the request, or null. */
  getUserId?: (c: Context) => string | null;
  /** Path prefixes to skip — a request is skipped when its path startsWith any. */
  excludePaths?: string[];
  /** SHA-256 the client IP before storage (REQUIREMENTS.md §1.1). Default true. */
  hashIPs?: boolean;
  /**
   * Visitor-token store (REQUIREMENTS.md §2). When provided, unauthenticated
   * requests get a token (minted or reused via `_t`) and first-touch attribution.
   * When omitted, the middleware logs requests without any token logic.
   */
  tokenStore?: VisitorTokenStore;
  /**
   * Resolve the client's socket address when X-Forwarded-For is absent
   * (REQUIREMENTS.md §1.1 "x-forwarded-for or socket"). Defaults to Bun's
   * `getConnInfo`; override for other runtimes or in tests.
   */
  getClientAddress?: (c: Context) => string | undefined;
}

/**
 * Hono middleware that logs every request as a `request` event (REQUIREMENTS.md
 * §1.1) and, when a token store is configured, tracks anonymous visitors (§2/§3).
 *
 * Visitor-token resolution runs BEFORE `await next()` so the host handler can read
 * `c.get('beaconVisitorToken')` while rendering (to append `?_t=` to links). Event
 * logging stays in `finally` so it survives a propagating handler error. Every
 * Beacon step is individually guarded: a failure here never crashes the host and
 * never masks a handler error (§1.3 failure isolation).
 */
export function requestLogger(buffer: EventBuffer, opts: RequestLoggerOptions): MiddlewareHandler {
  const {
    productId,
    getUserId,
    excludePaths = [],
    hashIPs = true,
    tokenStore,
    getClientAddress = defaultClientAddress,
  } = opts;

  return async (c, next) => {
    const path = c.req.path;
    if (excludePaths.some((prefix) => path.startsWith(prefix))) {
      await next();
      return;
    }

    // Resolved once, before next(): the IP/UA seed the token record, and the
    // token must be on the context before the handler renders.
    const ip = resolveIp(c, hashIPs, getClientAddress);
    const userAgent = c.req.header('user-agent');

    // getUserId is host-supplied; a throw here drops logging for this request
    // (we can't attribute it) but must never crash the host.
    let userId: string | null = null;
    let canLog = true;
    try {
      userId = getUserId?.(c) ?? null;
    } catch (err) {
      console.warn(`[beacon] getUserId failed: ${String(err)}`);
      canLog = false;
    }

    // Authenticated requests skip token logic. A token-store failure must not
    // lose the request event, so it's guarded separately from logging.
    let visitorToken: string | null = null;
    if (canLog && tokenStore && userId === null) {
      try {
        visitorToken = resolveVisitorToken(c, tokenStore, ip, userAgent);
        c.set('beaconVisitorToken', visitorToken);
      } catch (err) {
        console.warn(`[beacon] visitor token resolution failed: ${String(err)}`);
        visitorToken = null;
      }
      // Attribution is best-effort ON TOP of an already-minted token: capture it
      // in a separate guard so a setAttribution failure can't orphan the record
      // or strip the (valid) token from the event/context.
      if (visitorToken !== null) {
        try {
          captureAttribution(c, tokenStore, visitorToken);
        } catch (err) {
          console.warn(`[beacon] attribution capture failed: ${String(err)}`);
        }
      }
    }

    // Request-start time, captured before next(). This becomes the event's
    // `timestamp` (client/event time) — distinct from received_at (the server
    // ingest time, set by the column DEFAULT at flush). Stamping here, rather
    // than letting the buffer default it at flush, gives each event a stable
    // per-request time so first-touch ordering survives batching (§4.1).
    const requestTime = new Date();
    const start = Date.now();
    let threw = false;
    try {
      await next();
    } catch (err) {
      // The error propagated past await next() (no onError, or onError rethrew),
      // so no response was produced — record it as a 500 and re-throw so the
      // host's error handling is unaffected.
      threw = true;
      throw err;
    } finally {
      if (canLog) {
        try {
          // c.error stays set even when a non-rethrowing onError produced a real
          // response (Hono's compose never clears it), so we key off whether the
          // error actually propagated. If next() resolved, c.res.status is the
          // true status — including an onError-supplied 4xx/3xx.
          const status = threw ? 500 : c.res.status;
          buffer.push(
            buildEvent(c, {
              productId,
              userId,
              visitorToken,
              ip,
              path,
              requestTime,
              responseTimeMs: Date.now() - start,
              status,
            }),
          );
        } catch (err) {
          console.warn(`[beacon] request logging failed: ${String(err)}`);
        }
      }
    }
  };
}

/** Mint or reuse a visitor token (§2). Attribution is captured separately. */
function resolveVisitorToken(
  c: Context,
  store: VisitorTokenStore,
  ip: string | undefined,
  userAgent: string | undefined,
): string {
  const param = c.req.query('_t');
  const existing = param ? store.get(param) : null;
  if (existing) {
    store.touch(existing.token);
    return existing.token;
  }
  // `ip` is the configured IP representation — SHA-256 hashed by default, or the
  // raw IP when hashIPs is off — so the record's ipHash field mirrors what the
  // event stores. It is in-memory and TTL-bounded; nothing here is persisted.
  return store.create(ip ?? '', userAgent ?? '');
}

/** Record first-touch attribution for a resolved token (§3). Best-effort. */
function captureAttribution(c: Context, store: VisitorTokenStore, token: string): void {
  const attribution = extractAttribution(c.req.url);
  if (attribution) store.setAttribution(token, attribution);
}

interface BuildArgs {
  productId: string;
  userId: string | null;
  visitorToken: string | null;
  ip: string | undefined;
  path: string;
  /** Event time (request start), distinct from received_at (server ingest). */
  requestTime: Date;
  responseTimeMs: number;
  status: number;
}

function buildEvent(c: Context, args: BuildArgs): BeaconEvent {
  const { productId, userId, visitorToken, ip, path, requestTime, responseTimeMs, status } = args;

  // Transport `context` + platform come from the shared builder so a track()
  // event and this request event are assembled identically.
  const { context, platform } = buildEventContext(c, ip);

  return {
    productId,
    eventType: 'request',
    timestamp: requestTime,
    userId,
    visitorToken,
    platform,
    properties: {
      path,
      method: c.req.method,
      status,
      response_time_ms: responseTimeMs,
    },
    context,
  };
}
