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
