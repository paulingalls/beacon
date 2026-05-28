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
