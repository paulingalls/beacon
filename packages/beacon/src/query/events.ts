import { Buffer } from 'node:buffer';

import type { Context, Handler } from 'hono';
import type { Sql } from 'postgres';

import { errorResponse } from '../api/errors';
import { parseCommonParams, QueryParamError } from '../api/params';

// Paginated event stream (REQUIREMENTS.md §5.4 GET /analytics/events). Accepts the
// §5.3 common params plus event_type / limit / cursor, and returns events newest
// first with keyset pagination over (timestamp DESC, event_id DESC).

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

/** A pagination cursor's decoded keyset: the last-seen row's sort key. */
interface CursorKey {
  /** ISO timestamp of the last returned row. */
  t: string;
  /** event_id of the last returned row (UUID). */
  id: string;
}

/**
 * Parse the `limit` param: default 100, capped at 1000, must be a positive
 * integer. A blank value is treated as absent (story-001 blank-normalization
 * convention). Throws QueryParamError (→ 400) on a non-positive-integer value.
 */
export function parseLimit(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_LIMIT;
  if (!/^\d+$/.test(raw.trim())) {
    throw new QueryParamError('limit', "'limit' must be a positive integer");
  }
  const value = Number(raw.trim());
  if (value < 1) throw new QueryParamError('limit', "'limit' must be a positive integer");
  return Math.min(value, MAX_LIMIT);
}

/** Encode a keyset into the opaque base64 pagination cursor (§5.4). */
export function encodeCursor(t: string, id: string): string {
  return Buffer.from(JSON.stringify({ t, id }), 'utf8').toString('base64');
}

/**
 * Decode the base64 cursor back into its keyset. The §5.4 example cursor is a
 * base64 JSON object (`{"t":…,"id":…}`), carrying both keys so the keyset query
 * needs no lookup. Throws QueryParamError (→ 400) on any malformed input.
 */
export function decodeCursor(raw: string): CursorKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    throw new QueryParamError('cursor', "'cursor' is not a valid pagination cursor");
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).t !== 'string' ||
    typeof (parsed as Record<string, unknown>).id !== 'string'
  ) {
    throw new QueryParamError('cursor', "'cursor' is not a valid pagination cursor");
  }
  const { t, id } = parsed as CursorKey;
  // Validate the values, not just their types: a tampered cursor with junk t/id
  // would otherwise reach the ::timestamptz/::uuid SQL casts and surface as a
  // 500. Reject here so a bad cursor is a 400 like every other param error.
  if (Number.isNaN(Date.parse(t)) || !UUID_RE.test(id)) {
    throw new QueryParamError('cursor', "'cursor' is not a valid pagination cursor");
  }
  return { t, id };
}

/** Canonical 8-4-4-4-12 hex UUID shape (matches beacon_events.event_id). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A row as selected; jsonb columns arrive parsed, timestamp as a Date. */
interface EventRow {
  event_id: string;
  timestamp: Date;
  [key: string]: unknown;
}

/**
 * Build the GET /events handler (REQUIREMENTS.md §5.4). Param errors (bad common
 * param, limit, or cursor) become a §5.5 400 before any DB call; a query failure
 * becomes a §5.5 500 — neither crashes the host. Consumed by the story-007 router.
 */
export function createEventsHandler(sql: Sql): Handler {
  return async (c: Context) => {
    let common: ReturnType<typeof parseCommonParams>;
    let limit: number;
    let cursor: CursorKey | null;
    let eventType: string | undefined;
    try {
      common = parseCommonParams(c);
      limit = parseLimit(c.req.query('limit'));
      const rawCursor = c.req.query('cursor');
      cursor = rawCursor && rawCursor.trim() !== '' ? decodeCursor(rawCursor) : null;
      const rawType = c.req.query('event_type');
      eventType = rawType && rawType.trim() !== '' ? rawType.trim() : undefined;
    } catch (err) {
      if (err instanceof QueryParamError) {
        return errorResponse(c, 'INVALID_PARAMETER', err.message, err.parameter);
      }
      throw err;
    }

    try {
      // Compose the filters as nested tagged fragments so every value is
      // parameterized by postgres.js (never string-interpolated). The time
      // range is always present (§5.3 defaults); the rest are conditional.
      // §5.4 columns (no received_at — an ingest-time server column). visitor_token
      // IS returned: it is the visitor identity for cookie-free unauthenticated
      // traffic and a first-class queryable dimension (§5.4 schema.dimensions), so
      // the event stream surfaces it for consumers that count unique visitors.
      let q = sql`
        SELECT event_id, product_id, timestamp, event_type, user_id, visitor_token,
               platform, properties, context, attribution
        FROM beacon_events
        WHERE timestamp >= ${common.after} AND timestamp < ${common.before}`;
      if (common.productId) q = sql`${q} AND product_id = ${common.productId}`;
      if (eventType) q = sql`${q} AND event_type = ${eventType}`;
      if (common.platform) q = sql`${q} AND platform = ${common.platform}`;
      if (common.userId) q = sql`${q} AND user_id = ${common.userId}`;
      if (cursor) {
        // Keyset over the (timestamp DESC, event_id DESC) order. Expanded form
        // (not a row constructor) so each side carries an explicit cast.
        q = sql`${q} AND (timestamp < ${cursor.t}::timestamptz
          OR (timestamp = ${cursor.t}::timestamptz AND event_id < ${cursor.id}::uuid))`;
      }
      // Fetch one extra row to derive has_more without a COUNT.
      q = sql`${q} ORDER BY timestamp DESC, event_id DESC LIMIT ${limit + 1}`;

      const rows = (await q) as unknown as EventRow[];
      const hasMore = rows.length > limit;
      const events = hasMore ? rows.slice(0, limit) : rows;
      const last = events[events.length - 1];
      const cursorOut =
        hasMore && last ? encodeCursor(last.timestamp.toISOString(), last.event_id) : null;

      return c.json({ events, cursor: cursorOut, has_more: hasMore });
    } catch (err) {
      console.warn(`[beacon] events query failed: ${String(err)}`);
      return errorResponse(c, 'INTERNAL_ERROR', 'failed to query events');
    }
  };
}
