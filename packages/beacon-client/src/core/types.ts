// Core client types (REQUIREMENTS.md §8.1 / PHASE_8 §8.1-8.2). The BeaconClient
// collects events in a bounded in-memory queue and batches them to the server
// ingest endpoint. Events are camelCase in TS, mapped to the server's snake_case
// `event_type` only at POST time.

import type { AppContext } from '../context/appContext';

/** A client-side event awaiting delivery. `timestamp` is the client clock (ISO 8601). */
export interface BeaconEvent {
  eventType: string;
  properties?: Record<string, unknown>;
  timestamp?: string;
}

/**
 * Optional durable outbound buffer (host-supplied). Holds only undelivered event
 * payloads — no identifiers, no tracking state — and is cleared on a successful
 * flush. The one permitted client-side persistence (see CLAUDE.md outbound-queue
 * exception). The SDK adds no storage dependency.
 */
export interface BeaconStorageAdapter {
  load(): Promise<BeaconEvent[]>;
  save(events: BeaconEvent[]): Promise<void>;
  clear(): Promise<void>;
}

export interface BeaconClientConfig {
  /** Ingest endpoint the batch is POSTed to. */
  endpoint: string;
  /** Product this client logs for; sent as `product_id` in the batch body. */
  productId: string;
  /** Device/app context serialized into the X-App-Context header on every POST. */
  appContext: AppContext;
  /** Flush-timer interval in ms. Default 30000. */
  flushInterval?: number;
  /** Flush also fires when the queue reaches this size. Default 50. Must be ≤ 100 (server cap). */
  maxBatchSize?: number;
  /** Optional durable outbound queue so events survive app kills (mobile). */
  storage?: BeaconStorageAdapter;
  /** Host-supplied auth headers merged into every POST (PHASE_8 §8.2). */
  getHeaders?: () => Record<string, string>;
}

/**
 * Runtime/test seams — deliberately NOT part of the public config. Defaults to
 * the global fetch/timers/clock; tests inject fakes (bun:test has no fake timers,
 * so the timer + clock are injected, mirroring the server's `now`-injection idiom).
 */
export interface BeaconClientDeps {
  fetch?: typeof fetch;
  setInterval?: (handler: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval?: (handle: ReturnType<typeof setInterval>) => void;
  now?: () => number;
}

/**
 * Outcome of one batch POST.
 * - `sent`: delivered (2xx). - `drop`: non-429 4xx client error, discard.
 * - `retry`: 5xx / network failure, re-queue and consume one attempt.
 * - `pause`: 429 backpressure, re-queue WITHOUT consuming an attempt and pause
 *   flushing for `retryAfterMs` (server emits Retry-After as integer seconds).
 */
export type SendResult =
  | { kind: 'sent' }
  | { kind: 'drop' }
  | { kind: 'retry' }
  | { kind: 'pause'; retryAfterMs: number };

export const DEFAULT_FLUSH_INTERVAL = 30_000;
export const DEFAULT_MAX_BATCH_SIZE = 50;
/** Server `MAX_EVENTS_PER_REQUEST` — a single POST may not exceed this. */
export const MAX_EVENTS_PER_REQUEST = 100;
/** In-memory queue cap; oldest events are dropped on overflow. */
export const MAX_QUEUE_SIZE = 500;
/** 1 original attempt + 1 retry. Deliberately NOT the server buffer's 3. */
export const MAX_RETRY_ATTEMPTS = 2;
