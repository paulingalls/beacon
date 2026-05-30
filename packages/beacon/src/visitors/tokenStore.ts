import { randomBytes } from 'node:crypto';

import type {
  Attribution,
  VisitorTokenRecord,
  VisitorTokenStats,
  VisitorTokenStoreOptions,
} from '../types';

const DEFAULT_TTL = 1_800_000; // 30 minutes (REQUIREMENTS.md §2.2)
const DEFAULT_MAX_ENTRIES = 50_000;
const SWEEP_INTERVAL = 60_000; // §2.2: a sweep runs every 60 seconds

/**
 * In-memory store of anonymous visitor tokens (REQUIREMENTS.md §2.2). Tokens live
 * only here and in the `_t` URL param — never in client storage. Entries expire on
 * a sliding window measured from `lastSeenAt`; a 60s sweep removes stale ones, and
 * at capacity the oldest-by-lastSeenAt entry is evicted to make room.
 *
 * The 60s sweep starts in the constructor (unlike EventBuffer's explicit `start()`):
 * a TTL store with a forgotten start would silently leak memory, so it is on by
 * default. The interval is unref'd so it never keeps the process alive, and `stop()`
 * clears it for clean shutdown. A `now` clock can be injected for deterministic tests.
 */
export class VisitorTokenStore {
  private readonly records = new Map<string, VisitorTokenRecord>();
  private readonly ttl: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private evicted = 0;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: VisitorTokenStoreOptions = {}) {
    this.ttl = opts.ttl ?? DEFAULT_TTL;
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = opts.now ?? Date.now;
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL);
    // Don't let the sweep timer hold the event loop open (Bun/Node only).
    this.sweepTimer.unref?.();
  }

  /** Generate a 12-char URL-safe token and store a fresh record (§2.1). */
  create(ipHash: string, userAgent: string): string {
    if (this.records.size >= this.maxEntries) this.evictOldest();
    const token = randomBytes(9).toString('base64url').slice(0, 12);
    const ts = this.now();
    this.records.set(token, {
      token,
      createdAt: ts,
      lastSeenAt: ts,
      attribution: null,
      ipHash,
      userAgent,
    });
    return token;
  }

  /**
   * Read-only view of a record. Returned `Readonly` so callers can't bypass the
   * first-touch attribution guard (or the sliding-window touch) with a direct
   * field write — mutation must go through touch()/setAttribution().
   */
  get(token: string): Readonly<VisitorTokenRecord> | null {
    return this.records.get(token) ?? null;
  }

  /** Refresh lastSeenAt so the sliding-window TTL restarts. No-op if unknown. */
  touch(token: string): void {
    const record = this.records.get(token);
    if (!record) return;
    record.lastSeenAt = this.now();
    // Move to the Map's tail so insertion order tracks lastSeenAt ascending —
    // the invariant that lets evictOldest() pop the front in O(1). Every
    // lastSeenAt write MUST reorder; reads and setAttribution (no lastSeenAt
    // change) must NOT (decision: visitor-token-lifecycle eviction-order).
    this.records.delete(token);
    this.records.set(token, record);
  }

  /** First-touch only: store attribution once; later calls are ignored (§3.2). */
  setAttribution(token: string, attribution: Attribution): void {
    const record = this.records.get(token);
    // Mutates in place; does NOT touch lastSeenAt, so deliberately no reorder —
    // keeps the Map's order == lastSeenAt order (see touch()/evictOldest()).
    if (record && record.attribution === null) record.attribution = attribution;
  }

  remove(token: string): void {
    this.records.delete(token);
  }

  /** Drop entries whose sliding window has elapsed. Called by the 60s timer. */
  sweep(): void {
    const cutoff = this.now() - this.ttl;
    for (const [token, record] of this.records) {
      if (record.lastSeenAt < cutoff) this.records.delete(token);
    }
  }

  stats(): VisitorTokenStats {
    return { active: this.records.size, evicted: this.evicted };
  }

  /** Clear the sweep timer for shutdown. Safe to call more than once. */
  stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /**
   * Evict the oldest-by-lastSeenAt record to free capacity (§2.2). O(1): create()
   * and touch() keep the Map ordered by lastSeenAt ascending (newest at the tail),
   * so the FRONT is the least-recently-seen entry — pop it without scanning.
   *
   * Behaviour-preserving versus the former O(n) min-scan *under a monotonic clock*
   * (Date.now, the test fakeClock): each create/touch stamps now() ≥ all prior
   * values, so front == true min. A backward clock step (NTP correction) could pick
   * a non-oldest victim — an accepted tradeoff for a 30-min in-memory store.
   */
  private evictOldest(): void {
    const oldest = this.records.keys().next().value;
    if (oldest !== undefined) {
      this.records.delete(oldest);
      this.evicted += 1;
    }
  }
}
