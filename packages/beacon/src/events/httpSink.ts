import type { BeaconEvent, BufferStats } from '../types';
import type { EventSink } from './sink';

// HTTP event sink (execution_plan.json §Milestone 3, REQUIREMENTS.md §1.2/§6.2).
// The framework-agnostic emit path for a Bun.serve product: it batches events and
// POSTs them to a deployed Beacon's `POST {basePath}/events` over the M2 trusted
// boundary (Authorization: Bearer), so the product holds NO central-DB credentials.
// Mirrors EventBuffer's lifecycle (queue, interval/size flush, retry, backpressure,
// drain-on-stop) but flushes via fetch instead of Postgres. The bearer token is
// NEVER logged.

const DEFAULT_FLUSH_INTERVAL = 5000;
const DEFAULT_MAX_BATCH_SIZE = 100;
const DEFAULT_MAX_BUFFER_SIZE = 10_000;
const DEFAULT_MAX_RETRIES = 3;
const STOP_DRAIN_TIMEOUT = 5000;

export interface HttpSinkOptions {
  /** Full ingest URL to POST batches to, e.g. https://beacon.example/analytics/events. */
  endpoint: string;
  /** Shared secret for the M2 trusted-ingest bearer. Sent as `Authorization: Bearer`; never logged. */
  trustedIngestToken: string;
  /** Envelope product_id for every batch (beacon_events.product_id). */
  productId: string;
  /** Flush timer interval in ms. Default 5000. */
  flushInterval?: number;
  /** Max events drained per flush. Default 100. */
  maxBatchSize?: number;
  /** Max events held before push() drops (backpressure). Default 10000. */
  maxBufferSize?: number;
  /** Re-queue attempts before a transient failure is dropped. Default 3. */
  maxRetries?: number;
  /** fetch implementation; injectable for tests. Default globalThis.fetch. */
  fetch?: typeof fetch;
}

interface QueuedEvent {
  event: BeaconEvent;
  attempts: number;
}

/**
 * Batches events and POSTs them to a Beacon ingest endpoint over the trusted
 * bearer boundary. push() never blocks or throws. A drained batch is sent as ONE
 * request: user_id, context, and visitor_token all ride per-event in the body and
 * are honored under the bearer, so events from many anonymous visitors share a
 * single POST (no per-token fan-out). Failure handling distinguishes a caller error
 * from a transient outage: a 4xx (bad token / non-allowlisted product — won't fix on
 * retry) drops the batch loudly with the status (never the token); a 5xx or network
 * error re-queues for retry up to maxRetries.
 */
export class HttpSink implements EventSink {
  private readonly endpoint: string;
  private readonly token: string;
  private readonly productId: string;
  private readonly flushInterval: number;
  private readonly maxBatchSize: number;
  private readonly maxBufferSize: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;

  private readonly queue: QueuedEvent[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<void> | null = null;
  private started = false;

  private flushed = 0;
  private dropped = 0;
  private retryFailures = 0;

  constructor(opts: HttpSinkOptions) {
    this.endpoint = opts.endpoint;
    this.token = opts.trustedIngestToken;
    this.productId = opts.productId;
    this.flushInterval = opts.flushInterval ?? DEFAULT_FLUSH_INTERVAL;
    this.maxBatchSize = opts.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
    this.maxBufferSize = opts.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
  }

  /** Queue an event. Drops silently (counted) when the buffer is full. */
  push(event: BeaconEvent): void {
    if (this.queue.length >= this.maxBufferSize) {
      this.dropped += 1;
      return;
    }
    this.queue.push({ event, attempts: 0 });
    if (this.started && this.queue.length >= this.maxBatchSize) {
      void this.flush();
    }
  }

  /** POST one batch (up to maxBatchSize) as a single request. Concurrent calls coalesce. */
  flush(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (this.queue.length === 0) return Promise.resolve();
    this.inFlight = this.drainOneBatch().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async drainOneBatch(): Promise<void> {
    const batch = this.queue.splice(0, this.maxBatchSize);
    // One POST for the whole batch: ingest honors a per-event visitor_token under the
    // trusted bearer, so events from different anonymous visitors ride in a single
    // request (each carrying its own token in the wire shape) — no per-token fan-out.
    await this.sendBatch(batch);
  }

  private async sendBatch(group: QueuedEvent[]): Promise<void> {
    const body = JSON.stringify({
      product_id: this.productId,
      events: group.map((q) => toWire(q.event)),
    });

    let res: Response;
    try {
      res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
        body,
      });
    } catch (err) {
      // Network/transport error — transient, retry. (token never in the message)
      console.warn(`[beacon] HttpSink: POST failed (network): ${String(err)}`);
      this.requeueFailed(group);
      return;
    }

    if (res.ok) {
      this.flushed += group.length;
      return;
    }

    if (res.status >= 300 && res.status < 500) {
      // Caller/config error: a 3xx (endpoint misconfigured — fetch did not auto-
      // follow a redirect) or a 4xx (bad bearer / non-allowlisted product). Neither
      // succeeds on retry. Fail loud with the status so a misconfiguration surfaces
      // fast; NEVER log the token. Drop the batch (counted as retry failures).
      console.warn(
        `[beacon] HttpSink: ingest rejected batch with ${res.status}; dropped ${group.length} event(s)`,
      );
      this.retryFailures += group.length;
      return;
    }

    // 5xx — transient server error, retry.
    console.warn(`[beacon] HttpSink: ingest returned ${res.status}; will retry`);
    this.requeueFailed(group);
  }

  /** Begin the periodic flush timer. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.timer = setInterval(() => {
      void this.flush();
    }, this.flushInterval);
  }

  /** Stop the timer and drain remaining events, bounded by a 5s deadline. */
  async stop(): Promise<void> {
    this.started = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    let deadlineHandle: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      deadlineHandle = setTimeout(resolve, STOP_DRAIN_TIMEOUT);
    });
    const drain = (async () => {
      if (this.inFlight) await this.inFlight;
      while (this.queue.length > 0) {
        const before = this.queue.length;
        await this.flush();
        // No progress (persistent failure) — stop rather than spin to the deadline.
        if (this.queue.length >= before) break;
      }
    })();
    try {
      await Promise.race([drain, deadline]);
    } finally {
      if (deadlineHandle) clearTimeout(deadlineHandle);
    }
  }

  stats(): BufferStats {
    return {
      buffered: this.queue.length,
      flushed: this.flushed,
      dropped: this.dropped,
      retryFailures: this.retryFailures,
    };
  }

  /** Re-queue a failed group to the front; drop events that exhausted retries. */
  private requeueFailed(group: QueuedEvent[]): void {
    const survivors: QueuedEvent[] = [];
    for (const q of group) {
      q.attempts += 1;
      if (q.attempts >= this.maxRetries) {
        this.retryFailures += 1;
      } else {
        survivors.push(q);
      }
    }
    const room = Math.max(0, this.maxBufferSize - this.queue.length);
    this.dropped += Math.max(0, survivors.length - room);
    this.queue.unshift(...survivors.slice(0, room));
  }
}

/**
 * Serialize a server BeaconEvent to the ingest wire shape (api/ingest.ts RawEvent):
 * snake_case per-event fields, ISO-8601 timestamp. product_id is envelope-level (set in
 * sendBatch); user_id, context, and visitor_token ride per-event and are honored under the
 * trusted bearer, so a single batch can span multiple visitors.
 */
function toWire(e: BeaconEvent): Record<string, unknown> {
  return {
    event_type: e.eventType,
    ...(e.properties !== undefined ? { properties: e.properties } : {}),
    ...(e.timestamp !== undefined ? { timestamp: e.timestamp.toISOString() } : {}),
    ...(e.userId != null ? { user_id: e.userId } : {}),
    ...(e.visitorToken != null ? { visitor_token: e.visitorToken } : {}),
    ...(e.context !== undefined ? { context: e.context } : {}),
  };
}
