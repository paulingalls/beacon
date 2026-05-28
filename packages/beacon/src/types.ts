// Shared types for @pi-innovations/beacon.
//
// BeaconConfig (the full REQUIREMENTS.md §10 configuration contract) is added in
// story-003 alongside the createBeacon() factory, where the Hono Context-typed
// auth callbacks (getUserId/isAdmin) and the hono dependency land. The event
// buffer (story-001) needs only the event shape, its stats, and its own options.

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
