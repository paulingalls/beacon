import type { ShortLinkRecord } from './store';

/** Default LRU capacity (REQUIREMENTS.md §7.3 §10). */
const DEFAULT_SIZE = 10_000;
/** Default entry TTL in ms (REQUIREMENTS.md §7.3 §10). */
const DEFAULT_TTL = 300_000;

interface CacheEntry {
  record: ShortLinkRecord;
  /** Epoch-ms when this entry was cached, for TTL expiry. */
  cachedAt: number;
}

export interface ShortLinkCacheOptions {
  /** Loads a live link on a cache miss — typically `(code) => getShortLink(sql, code)`. */
  fetch: (code: string) => Promise<ShortLinkRecord | null>;
  /** Max entries before LRU eviction (default 10000). */
  size?: number;
  /** Per-entry TTL in ms (default 300000). */
  ttl?: number;
  /** Clock injection for deterministic tests (default Date.now). */
  now?: () => number;
}

/**
 * In-memory LRU cache for short-link lookups (REQUIREMENTS.md §7.3), wrapping a
 * `fetch` loader so `get` does the full cache-first / fall-through / populate
 * cycle. Two independent freshness checks run on every hit: the cache TTL
 * (entry age) AND the link's own `expires_at` — so a link that expires while
 * cached is never served stale (it re-fetches, and the store's SQL expiry
 * filter then returns null). A null fetch result is not cached, so unknown or
 * expired codes always re-hit the store rather than poisoning the cache.
 *
 * LRU order is the insertion order of a Map: a hit re-inserts the key (moving it
 * to most-recently-used), and eviction drops the first (least-recent) key.
 */
export class ShortLinkCache {
  private readonly loader: (code: string) => Promise<ShortLinkRecord | null>;
  private readonly size: number;
  private readonly ttl: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, CacheEntry>();

  constructor(opts: ShortLinkCacheOptions) {
    const size = opts.size ?? DEFAULT_SIZE;
    const ttl = opts.ttl ?? DEFAULT_TTL;
    // Fail fast on misconfiguration: size < 1 silently degrades to a size-1
    // cache (the at-capacity evict fires before every insert), and ttl < 1
    // makes every entry instantly stale — both confusing no-op-looking caches.
    // Reject at construction, not on the first get().
    if (!Number.isInteger(size) || size < 1) {
      throw new RangeError(`ShortLinkCache size must be an integer >= 1, got ${size}`);
    }
    if (!Number.isInteger(ttl) || ttl < 1) {
      throw new RangeError(`ShortLinkCache ttl must be an integer >= 1, got ${ttl}`);
    }
    this.loader = opts.fetch;
    this.size = size;
    this.ttl = ttl;
    this.now = opts.now ?? Date.now;
  }

  /** Cache-first lookup; falls through to the loader on miss/stale/expired. */
  async get(code: string): Promise<ShortLinkRecord | null> {
    const now = this.now();
    const entry = this.entries.get(code);
    if (entry && now - entry.cachedAt <= this.ttl && this.isLive(entry.record, now)) {
      // Hit: move to most-recently-used (re-insert) and serve without a load.
      this.entries.delete(code);
      this.entries.set(code, entry);
      return entry.record;
    }

    // Miss, TTL-expired, or link-expired: drop any stale entry and reload.
    if (entry) this.entries.delete(code);
    const record = await this.loader(code);
    if (record === null) return null; // never cache a negative result
    this.set(code, record);
    return record;
  }

  /** Cache a record at most-recently-used, evicting the LRU entry at capacity. */
  set(code: string, record: ShortLinkRecord): void {
    this.entries.delete(code); // re-insert moves an existing key to MRU
    if (this.entries.size >= this.size) {
      const lru = this.entries.keys().next().value;
      if (lru !== undefined) this.entries.delete(lru);
    }
    this.entries.set(code, { record, cachedAt: this.now() });
  }

  /** Remove a code from the cache (e.g. on link update/deletion). */
  invalidate(code: string): void {
    this.entries.delete(code);
  }

  /** A link is live when it has no expiry or its expiry is still in the future. */
  private isLive(record: ShortLinkRecord, now: number): boolean {
    return record.expires_at === null || record.expires_at.getTime() > now;
  }
}
