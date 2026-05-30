// Shared types for @pi-innovations/beacon.

import type { Context } from 'hono';

/**
 * Configuration for createBeacon() (REQUIREMENTS.md §10). Only the fields the
 * server middleware + event buffer consume are defined here; the query-API,
 * shortener, and dashboard config fields are added by the phases that use them.
 */
export interface BeaconConfig {
  productId: string;
  postgres: { connectionString: string; maxConnections?: number };
  /** Resolve the authenticated user id from the request, or null. */
  getUserId?: (c: Context) => string | null;
  /** Mount prefix for the API router (CLAUDE.md Configuration). Default '/analytics'. */
  basePath?: string;
  /** Path prefixes to skip logging (startsWith match). */
  excludePaths?: string[];
  /** SHA-256 the client IP before storage. Default true. */
  hashIPs?: boolean;
  /** Event-buffer flush timer interval in ms. Default 5000. */
  flushInterval?: number;
  /** Max events written per flush. Default 100. */
  maxBatchSize?: number;
  /** Max events held in memory before dropping. Default 10000. */
  maxBufferSize?: number;
  /** Visitor-token sliding-window TTL in ms (REQUIREMENTS.md §2.2). Default 1800000 (30 min). */
  visitorTokenTTL?: number;
  /** Max visitor tokens held in memory before oldest-by-lastSeenAt eviction. Default 50000. */
  maxVisitorTokens?: number;
}

/**
 * First-touch campaign attribution captured from a request URL (REQUIREMENTS.md
 * §3). A flat string map: UTM tags and ad-platform click IDs keep their original
 * param name; custom `_bcn_`-prefixed params are stored with the prefix stripped.
 */
export type Attribution = Record<string, string>;

/**
 * An anonymous visitor's in-memory tracking record (REQUIREMENTS.md §2.2). Lives
 * only in server memory, keyed by the `_t` token — never persisted client-side.
 * `createdAt`/`lastSeenAt` are epoch-ms; TTL is measured from `lastSeenAt`.
 */
export interface VisitorTokenRecord {
  token: string;
  createdAt: number;
  lastSeenAt: number;
  attribution: Attribution | null;
  ipHash: string;
  userAgent: string;
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

/**
 * An event queued for batched insertion into beacon_events.
 *
 * Field names are camelCase here and mapped to the snake_case columns at insert
 * time. `received_at` is deliberately absent: it is always server-set by the
 * column DEFAULT now(), never client-supplied (REQUIREMENTS.md §6 / §1.1).
 */
export interface BeaconEvent {
  productId: string;
  eventType: string;
  /** Event time (when it happened). Defaults to insert time when omitted. */
  timestamp?: Date;
  userId?: string | null;
  visitorToken?: string | null;
  /** Defaults to 'web' when omitted. */
  platform?: string;
  properties?: Record<string, unknown>;
  context?: Record<string, unknown>;
  attribution?: Record<string, unknown>;
}

/** Snapshot of buffer counters, exposed via EventBuffer.stats(). */
export interface BufferStats {
  /** Events currently waiting in the in-memory queue. */
  buffered: number;
  /** Events successfully written to Postgres since creation. */
  flushed: number;
  /** Events discarded by backpressure (queue at maxBufferSize). */
  dropped: number;
  /** Events discarded after exhausting retry attempts on write failure. */
  retryFailures: number;
}

/** Tuning options for EventBuffer (REQUIREMENTS.md §1.2). */
export interface EventBufferOptions {
  /** Flush timer interval in ms. Default 5000. */
  flushInterval?: number;
  /** Max events written per flush (one batch). Default 100. */
  maxBatchSize?: number;
  /** Max events held in memory; beyond this, push() drops. Default 10000. */
  maxBufferSize?: number;
}
