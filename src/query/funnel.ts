import type { Context, Handler } from 'hono';
import type { Sql } from 'postgres';

import { errorResponse } from '../api/errors';
import { parseCommonParams, QueryParamError } from '../api/params';

// Ordered-event conversion funnel (REQUIREMENTS.md §5.4 GET /analytics/funnel).
// Accepts the §5.3 common params plus `steps` (the ordered event types) and
// `window` (max seconds from the first step to each later step). For every entity
// — COALESCE(user_id, visitor_token) — we walk the steps in order: a step counts
// only when the entity has that event AFTER the previous completed step and within
// `window` seconds of its earliest step-1 event. Entities that miss a step are
// dropped from every later step (§5.4 line 418).

const DEFAULT_WINDOW = 86400; // 24h
const MIN_STEPS = 2;
const MAX_STEPS = 10;

/**
 * A required query parameter was absent (REQUIREMENTS.md §5.5 MISSING_PARAMETER).
 * Distinct from QueryParamError so the handler can map it to a 400 with the
 * MISSING_PARAMETER code rather than INVALID_PARAMETER.
 */
export class MissingParamError extends Error {
  readonly parameter: string;
  constructor(parameter: string, message: string) {
    super(message);
    this.name = 'MissingParamError';
    this.parameter = parameter;
  }
}

/** One row fed to the funnel computation: an entity, an event type, and its time. */
export interface FunnelRow {
  entity: string;
  event_type: string;
  timestamp: Date;
}

/**
 * Parse the required `steps` param: a comma-separated, ordered list of event
 * types. Blank-or-absent → MissingParamError (→ 400 MISSING_PARAMETER). A list
 * outside 2..10 real steps → QueryParamError (→ 400 INVALID_PARAMETER). Empty
 * segments (e.g. a trailing comma) are dropped before the count is checked.
 */
export function parseSteps(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') {
    throw new MissingParamError('steps', "'steps' is required");
  }
  const steps = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (steps.length < MIN_STEPS || steps.length > MAX_STEPS) {
    throw new QueryParamError(
      'steps',
      `'steps' must list between ${MIN_STEPS} and ${MAX_STEPS} event types`,
    );
  }
  return steps;
}

/**
 * Parse the optional `window` param (seconds between the first and each later
 * step): default 86400, must be a positive integer. A blank value is treated as
 * absent (story-001 blank-normalization). Throws QueryParamError (→ 400) on a
 * non-positive-integer value. Mirrors events.ts `parseLimit`.
 */
export function parseWindow(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_WINDOW;
  if (!/^\d+$/.test(raw.trim())) {
    throw new QueryParamError('window', "'window' must be a positive integer (seconds)");
  }
  const value = Number(raw.trim());
  if (value < 1) {
    throw new QueryParamError('window', "'window' must be a positive integer (seconds)");
  }
  return value;
}

/**
 * Count, per step, how many entities reached that step (§5.4 line 418).
 *
 * For each entity: anchor on its earliest step-1 event, then for each later step
 * take the earliest matching event strictly after the previous step's time and at
 * or before `anchor + window`. The first step an entity can't satisfy ends its
 * walk, so counts are monotonically non-increasing. Pure and DB-free for unit
 * testing; the handler feeds it the rows returned by a single filtered query.
 */
export function computeFunnelCounts(
  rows: FunnelRow[],
  steps: string[],
  windowSeconds: number,
): number[] {
  const windowMs = windowSeconds * 1000;

  const byEntity = new Map<string, FunnelRow[]>();
  for (const r of rows) {
    const list = byEntity.get(r.entity);
    if (list) list.push(r);
    else byEntity.set(r.entity, [r]);
  }

  // How many leading steps each entity completed (1..steps.length); 0 if it never
  // entered the funnel. counts[i] is then the number of entities that got that far.
  const reaches: number[] = [];
  for (const events of byEntity.values()) {
    // Step 1: anchor on the entity's earliest step-1 event.
    let anchor = Infinity;
    for (const e of events) {
      if (e.event_type === steps[0]) anchor = Math.min(anchor, e.timestamp.getTime());
    }
    if (anchor === Infinity) continue; // never entered the funnel

    const deadline = anchor + windowMs;
    let prev = anchor;
    let reached = 1;
    for (let i = 1; i < steps.length; i++) {
      // Earliest steps[i] event strictly after the previous step, within window.
      let best = Infinity;
      for (const e of events) {
        if (e.event_type !== steps[i]) continue;
        const t = e.timestamp.getTime();
        if (t > prev && t <= deadline) best = Math.min(best, t);
      }
      if (best === Infinity) break; // missed this step → excluded from the rest
      reached++;
      prev = best;
    }
    reaches.push(reached);
  }

  return steps.map((_, i) => reaches.filter((reached) => reached > i).length);
}

/** A funnel step in the §5.4 response: its event type, reach, and step-over-step rate. */
interface FunnelStepOut {
  event_type: string;
  count: number;
  conversion_rate: number;
}

/** Build the §5.4 `steps` array: step 1 is always 1.0; later steps are count[i]/count[i-1]. */
function buildSteps(steps: string[], counts: number[]): FunnelStepOut[] {
  return steps.map((event_type, i) => ({
    event_type,
    count: counts[i] as number,
    conversion_rate: i === 0 ? 1.0 : ratio(counts[i] as number, counts[i - 1] as number),
  }));
}

/** A divide-by-zero-guarded ratio (an empty prior step yields 0, never NaN). */
function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

/**
 * Build the GET /funnel handler (REQUIREMENTS.md §5.4). Param errors (missing or
 * malformed steps/window, or a bad common param) become a §5.5 400 before any DB
 * call; a query failure becomes a §5.5 500 — neither crashes the host. The whole
 * funnel is computed from a single filtered fetch. Consumed by the story-007 router.
 */
export function createFunnelHandler(sql: Sql): Handler {
  return async (c: Context) => {
    let common: ReturnType<typeof parseCommonParams>;
    let steps: string[];
    let windowSeconds: number;
    try {
      common = parseCommonParams(c);
      steps = parseSteps(c.req.query('steps'));
      windowSeconds = parseWindow(c.req.query('window'));
    } catch (err) {
      if (err instanceof MissingParamError) {
        return errorResponse(c, 'MISSING_PARAMETER', err.message, err.parameter);
      }
      if (err instanceof QueryParamError) {
        return errorResponse(c, 'INVALID_PARAMETER', err.message, err.parameter);
      }
      throw err;
    }

    try {
      // Fetch only the step events in range, tagged with their entity, then walk
      // the funnel in TS (§5.4). Every value is parameterized by postgres.js;
      // `steps` rides along as a Postgres array via ANY. Entities with neither a
      // user_id nor a visitor_token (entity IS NULL) can't be tracked, so drop them.
      let q = sql`
        SELECT COALESCE(user_id, visitor_token) AS entity, event_type, timestamp
        FROM beacon_events
        WHERE timestamp >= ${common.after} AND timestamp < ${common.before}
          AND event_type = ANY(${steps})
          AND COALESCE(user_id, visitor_token) IS NOT NULL`;
      if (common.productId) q = sql`${q} AND product_id = ${common.productId}`;
      if (common.platform) q = sql`${q} AND platform = ${common.platform}`;
      if (common.userId) q = sql`${q} AND user_id = ${common.userId}`;

      const rows = (await q) as unknown as FunnelRow[];
      const counts = computeFunnelCounts(rows, steps, windowSeconds);

      return c.json({
        steps: buildSteps(steps, counts),
        overall_conversion: ratio(counts[counts.length - 1] as number, counts[0] as number),
        window_seconds: windowSeconds,
        filters: { product_id: common.productId, after: common.after.toISOString() },
      });
    } catch (err) {
      console.warn(`[beacon] funnel query failed: ${String(err)}`);
      return errorResponse(c, 'INTERNAL_ERROR', 'failed to query funnel');
    }
  };
}
