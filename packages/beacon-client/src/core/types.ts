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
  /**
   * Optional anonymous visitor handle for cookie-free SPAs, sent as body.visitor_token on
   * every batch. When UNSET, the client mints a default in-memory crypto.randomUUID() at
   * construction so a non-seeding SPA still gets a stable anonymous trail; an explicit value
   * overrides the default, and an explicit empty string is left as-is (omitted from the body).
   * The host seeds it from the SPA bootstrap (its one server-rendered touchpoint); update it at
   * runtime via setVisitorToken(). Held in MEMORY ONLY — never written to the storage adapter
   * (which holds event payloads alone), preserving the no-client-storage posture.
   * A falsy/empty value is omitted from the body so the server falls back to the transport token.
   * Must be ≤100 chars: the server is the single validation authority and silently drops an
   * over-length token to its transport fallback, so a longer seed yields unattributed events.
   */
  visitorToken?: string;
  /** Flush-timer interval in ms. Default 30000. */
  flushInterval?: number;
  /** Flush also fires when the queue reaches this size. Default 50. Must be ≤ 100 (server cap). */
  maxBatchSize?: number;
  /** Optional durable outbound queue so events survive app kills (mobile). */
  storage?: BeaconStorageAdapter;
  /** Host-supplied auth headers merged into every POST (PHASE_8 §8.2). */
  getHeaders?: () => Record<string, string>;
  /**
   * Delivery-outcome callbacks (all optional, fail-isolated — a throw can never break the
   * drain). They observe each batch POST; they do not alter retry/drop behavior.
   * - `onSent`: the batch was accepted (2xx). `productIdUsed` is the server's resolved
   *   product_id from the 202 body — lets the host detect its events were attributed to a
   *   different product than intended.
   * - `onDrop`: the batch was permanently dropped — events the SDK will NOT retry. Three
   *   disjoint triggers, distinguished by `info`: a server REJECTION (non-429 4xx, e.g. a
   *   product-allowlist 403) carries `info.status`; a RETRY EXHAUSTION (a transient failure
   *   retried up to MAX_RETRY_ATTEMPTS) carries `info.exhausted === true` and no status; a
   *   QUEUE OVERFLOW (the bounded queue dropped the oldest event(s) to stay under
   *   MAX_QUEUE_SIZE — on track(), on re-queue of a failed/paused batch, or on restore of a
   *   persisted queue) carries `info.reason === 'overflow'`. So a host accounting for every
   *   event can detect overflow loss via `onDrop`, not just silent eviction.
   * - `onError`: a TRANSIENT failure (5xx → `info.status`; thrown fetch → `info.error`). The
   *   events are retried ONCE (MAX_RETRY_ATTEMPTS); on the second consecutive transient
   *   failure they are dropped and `onDrop` fires with `info.exhausted` — so a host accounting
   *   for every event can detect retry-exhaustion loss via `onDrop`, not just repeated `onError`.
   */
  onSent?: (events: BeaconEvent[], info: { productIdUsed?: string }) => void;
  onDrop?: (
    events: BeaconEvent[],
    info: { status?: number; exhausted?: boolean; reason?: 'overflow' },
  ) => void;
  onError?: (events: BeaconEvent[], info: { status?: number; error?: unknown }) => void;
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
  /** Mints the default visitor token when config.visitorToken is unset. Defaults to the
   * global crypto.randomUUID; tests inject a deterministic stub. */
  randomUUID?: () => string;
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
