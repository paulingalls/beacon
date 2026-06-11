// BeaconClient — the platform-agnostic core (REQUIREMENTS.md §8.1, §6.2 / PHASE_8
// §8.1-8.2). Collects events in a bounded in-memory queue and batches them to the
// server ingest endpoint (POST {product_id, events:[...]}). Mirrors the server
// EventBuffer (packages/beacon/src/events/buffer.ts): an inFlight concurrent-flush
// guard, splice-from-front draining, and re-queue-to-front with a per-event attempts
// counter. No client-side tracking state — the queue is the permitted transient
// outbound buffer (CLAUDE.md), optionally persisted via a host-supplied storage adapter.

import { buildAppContextHeader } from '../context/appContext';
import {
  type BeaconClientConfig,
  type BeaconClientDeps,
  type BeaconEvent,
  DEFAULT_FLUSH_INTERVAL,
  DEFAULT_MAX_BATCH_SIZE,
  MAX_EVENTS_PER_REQUEST,
  MAX_QUEUE_SIZE,
  MAX_RETRY_ATTEMPTS,
  type SendResult,
} from './types';

interface QueuedEvent {
  event: BeaconEvent;
  attempts: number;
}

export class BeaconClient {
  private readonly config: BeaconClientConfig;
  private readonly flushInterval: number;
  private readonly maxBatchSize: number;
  private readonly fetchFn: typeof fetch;
  private readonly setIntervalFn: NonNullable<BeaconClientDeps['setInterval']>;
  private readonly clearIntervalFn: NonNullable<BeaconClientDeps['clearInterval']>;
  private readonly now: () => number;

  private readonly queue: QueuedEvent[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<void> | null = null;
  private readonly restorePromise: Promise<void>;
  /** While `now() < pausedUntil` no batch is sent — honors a 429 Retry-After. */
  private pausedUntil = 0;
  /** appContext is invariant — build the header once (sendBatch/getContextHeaders reuse it). */
  private readonly contextHeader: Record<string, string>;
  /**
   * Serializes all durable-store mutations (restore-merge → save → clear) onto one
   * chain so a fire-and-forget save can't land after a clear, or a clear wipe a
   * just-tracked event. Best-effort: each link swallows its own error.
   */
  private storageChain: Promise<void> = Promise.resolve();
  /** True while a persist link is queued but not yet running — see persist(). */
  private persistQueued = false;

  constructor(config: BeaconClientConfig, deps: BeaconClientDeps = {}) {
    if (typeof config.endpoint !== 'string' || config.endpoint === '') {
      throw new RangeError('BeaconClient: endpoint must be a non-empty string');
    }
    if (typeof config.productId !== 'string' || config.productId === '') {
      throw new RangeError('BeaconClient: productId must be a non-empty string');
    }
    const flushInterval = config.flushInterval ?? DEFAULT_FLUSH_INTERVAL;
    if (!Number.isInteger(flushInterval) || flushInterval < 1) {
      throw new RangeError(
        `BeaconClient: flushInterval must be a positive integer, got ${flushInterval}`,
      );
    }
    const maxBatchSize = config.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
    if (
      !Number.isInteger(maxBatchSize) ||
      maxBatchSize < 1 ||
      maxBatchSize > MAX_EVENTS_PER_REQUEST
    ) {
      throw new RangeError(
        `BeaconClient: maxBatchSize must be an integer in 1..${MAX_EVENTS_PER_REQUEST}, got ${maxBatchSize}`,
      );
    }

    this.config = config;
    this.flushInterval = flushInterval;
    this.maxBatchSize = maxBatchSize;
    this.fetchFn = deps.fetch ?? globalThis.fetch;
    this.setIntervalFn = deps.setInterval ?? ((h, ms) => setInterval(h, ms));
    this.clearIntervalFn = deps.clearInterval ?? ((t) => clearInterval(t));
    this.now = deps.now ?? Date.now;
    this.contextHeader = buildAppContextHeader(config.appContext);

    // Restore a persisted outbound queue (mobile); drain() awaits this so a flush
    // can never race ahead of the load and clear() events that were never sent.
    this.restorePromise = this.restore();
    // Timer starts on construction (§8.2). Errors are handled inside drain().
    this.timer = this.setIntervalFn(() => void this.flush(), this.flushInterval);
  }

  /** Queue a custom event. Drops the oldest event when the queue is full (§8.1). */
  track(eventType: string, properties?: Record<string, unknown>): void {
    if (this.queue.length >= MAX_QUEUE_SIZE) this.queue.shift();
    const event: BeaconEvent = {
      eventType,
      ...(properties !== undefined ? { properties } : {}),
      timestamp: new Date(this.now()).toISOString(),
    };
    this.queue.push({ event, attempts: 0 });
    this.persist();
    if (this.queue.length >= this.maxBatchSize) void this.flush();
  }

  /** Convenience for a screen-view event (§8.1). */
  screenView(screenName: string): void {
    this.track('screen_view', { screen: screenName });
  }

  /** Headers the host app attaches to every outgoing request so the server captures context. */
  getContextHeaders(): Record<string, string> {
    return { ...this.contextHeader };
  }

  /** Flush queued events. Concurrent calls coalesce onto the in-flight drain. */
  flush(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.drain().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** Teardown: clear the queue, cancel the timer, and clear the durable store. */
  shutdown(): void {
    this.queue.length = 0;
    if (this.timer !== undefined) {
      this.clearIntervalFn(this.timer);
      this.timer = undefined;
    }
    this.clearStore();
  }

  /**
   * Deliver one batch via a host transport (e.g. navigator.sendBeacon) for reliable delivery
   * while the page unloads — a plain fetch without keepalive is cancelled on page-discard. The
   * client builds the {product_id, events} body (≤ maxBatchSize ≤ the server's 100-event cap)
   * and clears the sent batch when `send` returns true. A beacon carries no X-App-Context/auth
   * headers, so the server records platform 'web' with no user association for these events.
   * Empty queue → no-op (returns true). Reads the queue synchronously (no restore await) — the
   * unload path has no time to await, and restore completes at construction.
   */
  flushViaBeacon(send: (url: string, body: string) => boolean): boolean {
    if (this.queue.length === 0) return true;
    const batch = this.queue.slice(0, this.maxBatchSize);
    const ok = send(this.config.endpoint, this.buildBody(batch));
    if (ok) {
      this.queue.splice(0, batch.length);
      this.persist();
    }
    return ok;
  }

  /** Drain the queue in ≤maxBatchSize chunks, stopping at the first chunk that can't be sent. */
  private async drain(): Promise<void> {
    await this.restorePromise;
    const hadEvents = this.queue.length > 0;
    while (this.queue.length > 0) {
      if (this.now() < this.pausedUntil) break; // 429 backpressure
      const batch = this.queue.splice(0, this.maxBatchSize);
      const result = await this.sendBatch(batch);
      if (result.kind === 'sent' || result.kind === 'drop') continue;
      if (result.kind === 'retry') {
        this.requeueFailed(batch);
        break;
      }
      this.requeuePause(batch, result.retryAfterMs);
      break;
    }
    // Clear the durable store once a drain that started with events ends empty.
    if (hadEvents && this.queue.length === 0) this.clearStore();
  }

  /** The single source of truth for the ingest wire shape: {product_id, events}. */
  private buildBody(batch: QueuedEvent[]): string {
    return JSON.stringify({
      product_id: this.config.productId,
      events: batch.map((q) => toWire(q.event)),
    });
  }

  private async sendBatch(batch: QueuedEvent[]): Promise<SendResult> {
    const body = this.buildBody(batch);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...this.contextHeader,
      ...(this.config.getHeaders?.() ?? {}),
    };
    try {
      const res = await this.fetchFn(this.config.endpoint, { method: 'POST', headers, body });
      if (res.ok) {
        await this.notifySent(batch, res);
        return { kind: 'sent' };
      }
      if (res.status === 429) return { kind: 'pause', retryAfterMs: parseRetryAfter(res) };
      if (res.status >= 400 && res.status < 500) {
        // Server REJECTED the batch (e.g. product-allowlist 403): discard, do not retry.
        this.notify(this.config.onDrop, batch, { status: res.status });
        return { kind: 'drop' };
      }
      // 5xx — transient; events are retained and retried.
      this.notify(this.config.onError, batch, { status: res.status });
      return { kind: 'retry' };
    } catch (error) {
      // Network failure — transient; events are retained and retried.
      this.notify(this.config.onError, batch, { error });
      return { kind: 'retry' };
    }
  }

  /**
   * Invoke a delivery-outcome callback (onDrop/onError) with the batch's events, isolated so
   * a throwing host callback can never break the drain (mirrors the server's getUserId guard).
   */
  private notify<I>(
    cb: ((events: BeaconEvent[], info: I) => void) | undefined,
    batch: QueuedEvent[],
    info: I,
  ): void {
    if (!cb) return;
    try {
      cb(
        batch.map((q) => q.event),
        info,
      );
    } catch {
      // Host callback isolation — observation must never affect delivery.
    }
  }

  /** Fire onSent for an accepted batch, surfacing product_id_used parsed from the 202 body. */
  private async notifySent(batch: QueuedEvent[], res: { json(): Promise<unknown> }): Promise<void> {
    const onSent = this.config.onSent;
    if (!onSent) return; // skip the body read entirely when no consumer
    let productIdUsed: string | undefined;
    try {
      const parsed = (await res.json()) as { product_id_used?: unknown };
      if (typeof parsed?.product_id_used === 'string') productIdUsed = parsed.product_id_used;
    } catch {
      // Body absent / non-JSON — surface the send without a resolved product_id.
    }
    this.notify(onSent, batch, { productIdUsed });
  }

  /** Re-queue a failed batch to the front; drop events that have exhausted their 1 retry. */
  private requeueFailed(batch: QueuedEvent[]): void {
    const exhausted: QueuedEvent[] = [];
    const survivors = batch.filter((q) => {
      q.attempts += 1;
      if (q.attempts < MAX_RETRY_ATTEMPTS) return true; // attempt 1 keeps; 2 drops (1 retry total)
      exhausted.push(q);
      return false;
    });
    // Surface retry-exhaustion loss: a host using onDrop to account for every event would
    // otherwise miss these (only server rejections fired onDrop before). info.exhausted (no
    // status) distinguishes them from a 4xx rejection drop.
    if (exhausted.length > 0) this.notify(this.config.onDrop, exhausted, { exhausted: true });
    // Re-queueing to the FRONT: these survivors are the oldest events in the system.
    // Under the drop-oldest invariant an overflow must drop the OLDEST, so keep the
    // NEWEST `room` survivors (the tail), not the head.
    const room = Math.max(0, MAX_QUEUE_SIZE - this.queue.length);
    this.queue.unshift(...survivors.slice(survivors.length - room));
    this.persist();
  }

  /** Re-queue a rate-limited batch to the front WITHOUT consuming an attempt, and pause. */
  private requeuePause(batch: QueuedEvent[], retryAfterMs: number): void {
    // Same drop-oldest reasoning as requeueFailed: keep the NEWEST `room` of the batch.
    const room = Math.max(0, MAX_QUEUE_SIZE - this.queue.length);
    this.queue.unshift(...batch.slice(batch.length - room));
    this.pausedUntil = this.now() + retryAfterMs;
    this.persist();
  }

  private restore(): Promise<void> {
    const storage = this.config.storage;
    if (!storage) return Promise.resolve();
    // Kick off load() synchronously at construction (so a flush awaiting restorePromise
    // sees an in-flight load), but merge + persist on the storage chain. A concurrent
    // track()→persist (also chained, hence ordered AFTER this merge) then can't overwrite
    // restored events with a queue snapshot that omits them.
    const loading = storage.load();
    this.storageChain = this.storageChain.then(async () => {
      try {
        const loaded = await loading;
        // Restored events are older than anything tracked meanwhile → prepend to front.
        this.queue.unshift(...loaded.map((event) => ({ event, attempts: 0 })));
        while (this.queue.length > MAX_QUEUE_SIZE) this.queue.shift();
        await storage.save(this.queue.map((q) => q.event));
      } catch {
        // Best-effort durability — a failed restore must not break construction.
      }
    });
    return this.storageChain;
  }

  private persist(): void {
    const storage = this.config.storage;
    if (!storage) return;
    // Coalesce: a queued-but-not-yet-run link will snapshot the queue when it RUNS,
    // so it already covers every mutation made before then — a second link would
    // save the identical snapshot. Without this, a burst of N track()s chains N
    // whole-queue saves (O(N^2) serialization toward the 500 cap).
    if (this.persistQueued) return;
    this.persistQueued = true;
    // Snapshot the queue when the chain LINK RUNS (not at call time) so a restore-merge
    // queued ahead of us is reflected — otherwise a track() racing restore would persist a
    // stale snapshot that omits the just-restored events.
    this.storageChain = this.storageChain.then(async () => {
      // Reset BEFORE the snapshot: a mutation landing after this point needs its
      // own later persist — resetting after the save would silently drop it.
      this.persistQueued = false;
      try {
        await storage.save(this.queue.map((q) => q.event));
      } catch {
        // Best-effort — the in-memory queue stays the source of truth.
      }
    });
  }

  private clearStore(): void {
    const storage = this.config.storage;
    if (!storage) return;
    // A pending persist link runs BEFORE this clear, so it can no longer cover
    // mutations that land after the clear is queued — without this reset, such a
    // mutation's persist() would be skipped and the clear would wipe its event
    // from the durable store (lost on app kill). Reset so it queues a fresh link.
    this.persistQueued = false;
    this.storageChain = this.storageChain.then(async () => {
      try {
        await storage.clear();
      } catch {
        // Best-effort — the in-memory queue stays the source of truth.
      }
    });
  }
}

/** Map a client BeaconEvent (camelCase) to the server wire shape (snake_case event_type). */
function toWire(event: BeaconEvent): Record<string, unknown> {
  return {
    event_type: event.eventType,
    ...(event.properties !== undefined ? { properties: event.properties } : {}),
    ...(event.timestamp !== undefined ? { timestamp: event.timestamp } : {}),
  };
}

/** Parse a Retry-After header (integer delta-seconds) into ms; 0 when absent/invalid. */
function parseRetryAfter(res: { headers: { get(name: string): string | null } }): number {
  const seconds = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}
