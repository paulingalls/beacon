// DB/buffer-internal types for the private @pi-innovations/beacon-server.
//
// These tuning types belong to server internals relocated from the SDK in M4
// (story-005): the EventBuffer (Postgres flush) and the VisitorTokenStore. They
// live with their only consumers (events/buffer.ts, visitors/tokenStore.ts) and
// are deliberately NOT part of the published @pi-innovations/beacon-sdk surface —
// the wire-contract types stay there.

/** Tuning options for EventBuffer (REQUIREMENTS.md §1.2). */
export interface EventBufferOptions {
  /** Flush timer interval in ms. Default 5000. */
  flushInterval?: number;
  /** Max events written per flush (one batch). Default 100. */
  maxBatchSize?: number;
  /** Max events held in memory; beyond this, push() drops. Default 10000. */
  maxBufferSize?: number;
}

/** Tuning options for VisitorTokenStore (REQUIREMENTS.md §2.2). */
export interface VisitorTokenStoreOptions {
  /** Sliding-window TTL in ms, measured from lastSeenAt. Default 1800000. */
  ttl?: number;
  /** Max records held; at capacity, oldest-by-lastSeenAt is evicted. Default 50000. */
  maxEntries?: number;
  /** Clock injection for deterministic tests. Default Date.now. */
  now?: () => number;
}

/** Snapshot of VisitorTokenStore counters, exposed via stats(). */
export interface VisitorTokenStats {
  /** Records currently held in memory. */
  active: number;
  /** Records discarded by capacity eviction (not TTL expiry). */
  evicted: number;
}
