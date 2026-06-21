// Wire-contract types for @pi-innovations/beacon-sdk — the shared shapes that
// cross the trusted ingest boundary. Server-only config (BeaconConfig) lives in
// apps/server/src/types.ts; this package stays postgres-free.

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

/**
 * Snapshot of sink counters, exposed via stats(). Shared by EventBuffer (flushes
 * to Postgres) and HttpSink (flushes via trusted-bearer POST), so the wording is
 * sink-agnostic: "flushed/dropped" describe the configured sink, not Postgres
 * specifically.
 */
export interface BufferStats {
  /** Events currently waiting in the in-memory queue. */
  buffered: number;
  /** Events successfully flushed to the sink since creation. */
  flushed: number;
  /** Events discarded by backpressure (queue at maxBufferSize). */
  dropped: number;
  /** Events discarded after exhausting retry attempts on a flush failure. */
  retryFailures: number;
}
