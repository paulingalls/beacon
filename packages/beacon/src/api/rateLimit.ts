import type { Context, MiddlewareHandler } from 'hono';

import { errorResponse } from './errors';

// In-memory sliding-window rate limiter (REQUIREMENTS.md §6.2). Keyed by an
// arbitrary identifier (client IP or authenticated user id) so the ingest
// endpoint can throttle 10 req/min per caller; reusable by the query API with
// its own window. Single-process, in-memory — no shared store.

export interface RateLimiterOptions {
  /** Max allowed requests per window. */
  limit: number;
  /** Sliding window length in milliseconds. */
  windowMs: number;
  /** Clock injection for deterministic tests. Default Date.now. */
  now?: () => number;
}

/** The verdict for one request: whether it is allowed and, if not, when to retry. */
export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the caller may retry (0 when allowed; >= 1 when denied). */
  retryAfter: number;
}

/**
 * Sliding-**log** limiter: each identifier keeps the timestamps of its recent
 * allowed hits, pruned to the window on every check. A single check() returns
 * both the verdict and the Retry-After value so callers (the ingest endpoint)
 * make one call per request. Denied requests are not recorded, so a client
 * hammering at the limit cannot push its own reset further out.
 *
 * Memory per identifier is bounded by `limit`. Idle identifiers persist until
 * their next check() prunes them; a periodic sweep can be added if the key
 * space ever grows unbounded under load.
 */
export class RateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly hits = new Map<string, number[]>();

  constructor(opts: RateLimiterOptions) {
    // Fail fast on misconfiguration: a limit or window below 1 produces a
    // nonsensical verdict (limit < 1 denies every request with a NaN
    // retryAfter; windowMs < 1 reports retryAfter <= 0, breaking the
    // ">= 1 when denied" contract). Reject at construction, not at check().
    if (!Number.isInteger(opts.limit) || opts.limit < 1) {
      throw new RangeError(`RateLimiter limit must be an integer >= 1, got ${opts.limit}`);
    }
    if (!Number.isInteger(opts.windowMs) || opts.windowMs < 1) {
      throw new RangeError(`RateLimiter windowMs must be an integer >= 1, got ${opts.windowMs}`);
    }
    this.limit = opts.limit;
    this.windowMs = opts.windowMs;
    this.now = opts.now ?? Date.now;
  }

  /** Record-and-check one request for `identifier`. */
  check(identifier: string): RateLimitResult {
    const now = this.now();
    const threshold = now - this.windowMs;
    // Keep only hits still inside the window (strictly newer than the threshold,
    // so a hit exactly windowMs old has expired).
    const recent = (this.hits.get(identifier) ?? []).filter((t) => t > threshold);

    if (recent.length < this.limit) {
      recent.push(now);
      this.hits.set(identifier, recent);
      return { allowed: true, retryAfter: 0 };
    }

    // At capacity: store the pruned list (without the denied hit) and report how
    // long until the oldest in-window hit expires, freeing a slot.
    this.hits.set(identifier, recent);
    const oldest = recent[0] as number;
    const retryAfter = Math.ceil((oldest + this.windowMs - now) / 1000);
    return { allowed: false, retryAfter };
  }
}

/** Fallback rate-limit key for callers `getUserId` can't identify, so they share
 * one bucket rather than each getting a fresh limit and bypassing the cap. */
const ANONYMOUS_KEY = 'anonymous';

export interface RateLimitGateOptions {
  /** The shared sliding-window limiter (build once so its window persists). */
  limiter: RateLimiter;
  /**
   * Identify the caller for per-user limiting (REQUIREMENTS.md §5.2). Host-
   * supplied; a null return — or a throw — falls back to a single shared key, so
   * a buggy/absent identity fails closed into one bucket rather than uncapped.
   */
  getUserId: (c: Context) => string | null;
}

/**
 * Build the query-API rate-limit middleware (REQUIREMENTS.md §5.2). Keys the
 * limiter on `getUserId(c)`; on denial it sets `Retry-After` and returns the
 * §5.5 RATE_LIMITED 429 without calling the handler. `getUserId` runs inside a
 * try/catch (§1.3, mirroring adminGate): any throw falls back to the shared
 * anonymous bucket rather than surfacing a 500. Mounted ahead of every query
 * route by the router; the public ingest endpoint keeps its own separate limiter.
 */
export function rateLimitGate(opts: RateLimitGateOptions): MiddlewareHandler {
  return async (c, next) => {
    let key: string;
    try {
      key = opts.getUserId(c) ?? ANONYMOUS_KEY;
    } catch (err) {
      console.warn(`[beacon] rateLimitGate: getUserId failed: ${String(err)}`);
      key = ANONYMOUS_KEY;
    }

    const { allowed, retryAfter } = opts.limiter.check(key);
    if (!allowed) {
      c.header('Retry-After', String(retryAfter));
      return errorResponse(c, 'RATE_LIMITED', 'query rate limit exceeded');
    }
    await next();
  };
}
