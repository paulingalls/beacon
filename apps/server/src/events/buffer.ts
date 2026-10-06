import { createHash } from 'node:crypto';
import type { BeaconEvent, BufferStats } from '@pi-innovations/beacon-sdk';
import type { Sql } from 'postgres';

import type { JsonInput } from '../storage/db';
import type { EventBufferOptions } from '../types';

const DEFAULT_FLUSH_INTERVAL = 5000;
const DEFAULT_MAX_BATCH_SIZE = 100;
const DEFAULT_MAX_BUFFER_SIZE = 10_000;

/** Re-queue attempts per event before it is dropped as a retry failure. */
const MAX_RETRIES = 3;

/** Drain deadline for stop(), in ms (REQUIREMENTS.md §1.2 graceful shutdown). */
const STOP_DRAIN_TIMEOUT = 5000;

interface QueuedEvent {
  event: BeaconEvent;
  attempts: number;
  discarded?: boolean;
}

interface MetaRow {
  product_id: string;
  event_type: string;
  count: number;
}

/**
 * In-memory event buffer with batched, fire-and-forget flushing to Postgres
 * (REQUIREMENTS.md §1.2). push() never blocks and never throws; writes happen
 * asynchronously on a timer, when a batch fills, or on manual flush().
 *
 * Failure isolation (§1.3): a failed write re-queues the batch to the front and
 * retries up to MAX_RETRIES times before dropping. Backpressure drops (queue
 * full) and retry-exhaustion drops are counted separately in stats().
 */
export class EventBuffer {
  private readonly sql: Sql;
  private readonly flushInterval: number;
  private readonly maxBatchSize: number;
  private readonly maxBufferSize: number;

  private readonly queue: QueuedEvent[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  // The in-flight flush, if any. Concurrent callers await it rather than
  // starting a second batch — so a flush triggered by the timer, push(), or
  // stop() never overlaps another.
  private inFlight: Promise<void> | null = null;
  private activeBatch: QueuedEvent[] = [];
  private started = false;

  private flushed = 0;
  private dropped = 0;
  private retryFailures = 0;

  constructor(sql: Sql, opts: EventBufferOptions = {}) {
    this.sql = sql;
    this.flushInterval = opts.flushInterval ?? DEFAULT_FLUSH_INTERVAL;
    this.maxBatchSize = opts.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
    this.maxBufferSize = opts.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE;
  }

  /** Queue an event. Drops silently (counted) when the buffer is full. */
  push(event: BeaconEvent): void {
    if (this.queue.length >= this.maxBufferSize) {
      this.dropped += 1;
      return;
    }
    this.queue.push({ event, attempts: 0 });
    // Size-trigger: only while running, so pre-start/stopped pushes just buffer.
    if (this.started && this.queue.length >= this.maxBatchSize) {
      void this.flush();
    }
  }

  /**
   * Write one batch (up to maxBatchSize) to Postgres. Concurrent calls coalesce
   * onto the in-flight flush, so callers (including stop()) always await real
   * progress rather than returning early.
   */
  flush(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (this.queue.length === 0) return Promise.resolve();
    this.inFlight = this.drainOneBatch().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  async purgeUser(userId: string): Promise<void> {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i]?.event.userId === userId) this.queue.splice(i, 1);
    }
    for (const entry of this.activeBatch) {
      if (entry.event.userId === userId) entry.discarded = true;
    }
    if (this.inFlight) await this.inFlight;
  }

  private async drainOneBatch(): Promise<void> {
    const batch = this.queue.splice(0, this.maxBatchSize);
    this.activeBatch = batch;
    try {
      this.flushed += await this.writeBatch(batch.map((q) => q.event));
    } catch {
      this.requeueFailed(batch);
    } finally {
      this.activeBatch = [];
    }
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
      // Let any flush already running finish before assessing progress.
      if (this.inFlight) await this.inFlight;
      while (this.queue.length > 0) {
        const before = this.queue.length;
        await this.flush();
        // No progress (persistent write failure) — stop rather than spin until
        // the deadline; undrained events are lost on process exit (§1.3).
        if (this.queue.length >= before) break;
      }
    })();
    try {
      await Promise.race([drain, deadline]);
    } finally {
      // Clear the deadline so a pending timer can't keep the event loop alive.
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

  /** Re-queue a failed batch to the front; drop events that exhausted retries. */
  private requeueFailed(batch: QueuedEvent[]): void {
    const survivors: QueuedEvent[] = [];
    for (const q of batch) {
      if (q.discarded) continue;
      q.attempts += 1;
      if (q.attempts >= MAX_RETRIES) {
        this.retryFailures += 1;
      } else {
        survivors.push(q);
      }
    }
    // Re-queue survivors to the front; any that no longer fit are backpressure
    // drops (the buffer filled while this batch was out being written).
    const room = Math.max(0, this.maxBufferSize - this.queue.length);
    this.dropped += Math.max(0, survivors.length - room);
    this.queue.unshift(...survivors.slice(0, room));
  }

  /** Bulk-insert events and upsert beacon_meta in one transaction. */
  private async writeBatch(events: BeaconEvent[]): Promise<number> {
    return this.sql.begin(async (tx) => {
      await tx`LOCK TABLE beacon_events IN ROW EXCLUSIVE MODE`;
      const rows = events.map((e) => ({
        product_id: e.productId,
        event_type: e.eventType,
        timestamp: e.timestamp ?? new Date(),
        user_id: e.userId ?? null,
        visitor_token: e.visitorToken ?? null,
        platform: e.platform ?? 'web',
        // jsonb columns must be wrapped so postgres.js serializes them as JSON
        // rather than rejecting the plain object.
        properties: this.sql.json((e.properties ?? {}) as JsonInput),
        context: this.sql.json((e.context ?? {}) as JsonInput),
        attribution: this.sql.json((e.attribution ?? {}) as JsonInput),
      }));

      const candidates = rows.flatMap((row, ordinal) =>
        row.user_id === null
          ? []
          : [
              {
                ordinal,
                hash: createHash('sha256').update(row.user_id).digest('hex'),
                timestamp: row.timestamp.toISOString(),
              },
            ],
      );
      // Producer stamps and Postgres erasure time assume accepted NTP-bounded cross-host skew.
      const refused = candidates.length
        ? await tx<{ ordinal: number }[]>`
        SELECT candidate.ordinal
        FROM jsonb_to_recordset(${this.sql.json(candidates)})
          AS candidate(ordinal integer, hash text, timestamp timestamptz)
        WHERE EXISTS (
          SELECT 1 FROM beacon_erasures
          WHERE user_id_hash = candidate.hash AND erased_at >= candidate.timestamp
        )
      `
        : [];
      const refusedOrdinals = new Set(refused.map((row) => row.ordinal));
      const admittedRows = rows.filter((_, ordinal) => !refusedOrdinals.has(ordinal));
      if (admittedRows.length === 0) return 0;
      await tx`INSERT INTO beacon_events ${tx(admittedRows)}`;
      const metaRows = aggregateMeta(events.filter((_, ordinal) => !refusedOrdinals.has(ordinal)));
      await tx`
        INSERT INTO beacon_meta ${tx(metaRows, 'product_id', 'event_type', 'count')}
        ON CONFLICT (product_id, event_type)
        DO UPDATE SET count = beacon_meta.count + EXCLUDED.count, last_seen = now()
      `;
      return admittedRows.length;
    });
  }
}

/**
 * Aggregate a batch into one count per (product_id, event_type) pair for the
 * beacon_meta upsert (REQUIREMENTS.md §4.4). A nested map avoids a delimiter-
 * joined string key, so distinct pairs can never collide. Pre-aggregating also
 * keeps each conflict key unique within the statement, avoiding the
 * "ON CONFLICT cannot affect row a second time" cardinality error.
 */
function aggregateMeta(events: BeaconEvent[]): MetaRow[] {
  const byProduct = new Map<string, Map<string, number>>();
  for (const e of events) {
    let byType = byProduct.get(e.productId);
    if (!byType) {
      byType = new Map<string, number>();
      byProduct.set(e.productId, byType);
    }
    byType.set(e.eventType, (byType.get(e.eventType) ?? 0) + 1);
  }

  const rows: MetaRow[] = [];
  for (const [product_id, byType] of byProduct) {
    for (const [event_type, count] of byType) {
      rows.push({ product_id, event_type, count });
    }
  }
  return rows;
}
