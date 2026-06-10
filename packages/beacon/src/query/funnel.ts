import type { Context, Handler } from 'hono';
import type { Sql } from 'postgres';

import { errorResponse } from '../api/errors';
import {
  buildFilters,
  type CommonQueryParams,
  parseCommonParams,
  QueryParamError,
} from '../api/params';

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
 * Build the shared event-filter predicate fragment (aliased to `e`) for the
 * funnel query: the §5.3 time range and the optional product/platform/user
 * filters. Embedded in BOTH the anchor CTE and the recursive step lookup so each
 * touches `beacon_events` directly. Each call site adds its OWN exact
 * `event_type` equality (positional `steps[…]`), which fully constrains the step
 * type — so this fragment deliberately omits an `event_type = ANY(steps)` membership
 * test that the positional equalities would only subsume as dead filter work.
 * Mirrors the fragment-composition pattern in aggregate.ts. Every value stays a
 * bound param.
 */
function eventFilter(sql: Sql, common: CommonQueryParams) {
  let f = sql`e.timestamp >= ${common.after} AND e.timestamp < ${common.before}`;
  if (common.productId) f = sql`${f} AND e.product_id = ${common.productId}`;
  if (common.platform) f = sql`${f} AND e.platform = ${common.platform}`;
  if (common.userId) f = sql`${f} AND e.user_id = ${common.userId}`;
  return f;
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
 * Build the funnel-walk query (REQUIREMENTS.md §5.4) as a composable postgres.js
 * fragment, so it can be executed by the handler AND introspected (EXPLAIN) by the
 * live perf-guard test — concern 4d859cce846a.
 *
 * Walk the funnel entirely in Postgres so the handler receives only per-step counts,
 * never the full event set. `anchor` finds each entity's earliest step-1 event; the
 * recursive `walk` advances one step at a time, at each hop taking the earliest
 * next-step event strictly after the prior step and within the anchor-relative
 * deadline (frozen in the seed). A missed step (MIN over no rows → NULL) ends that
 * entity's walk, so an entity emits one row per step it reached — making COUNT(*)
 * grouped by step_idx the cumulative reach directly. Both branches filter against
 * beacon_events so the entity-step index can serve each hop (concern 18d098756f5a).
 * Entities with neither id (entity IS NULL) can't be tracked.
 */
export function funnelWalkQuery(
  sql: Sql,
  common: CommonQueryParams,
  steps: string[],
  windowSeconds: number,
) {
  return sql`
    WITH RECURSIVE
    anchor AS (
      SELECT COALESCE(e.user_id, e.visitor_token) AS entity, MIN(e.timestamp) AS anchor_ts
      FROM beacon_events e
      WHERE ${eventFilter(sql, common)}
        AND e.event_type = (${steps}::text[])[1]
        AND COALESCE(e.user_id, e.visitor_token) IS NOT NULL
      GROUP BY 1
    ),
    walk AS (
      SELECT entity, anchor_ts AS prev_ts, 1 AS step_idx,
             anchor_ts + ${windowSeconds} * interval '1 second' AS deadline
      FROM anchor
      UNION ALL
      SELECT w.entity, nxt.next_ts, w.step_idx + 1, w.deadline
      FROM walk w
      CROSS JOIN LATERAL (
        SELECT MIN(e.timestamp) AS next_ts
        FROM beacon_events e
        WHERE ${eventFilter(sql, common)}
          AND COALESCE(e.user_id, e.visitor_token) = w.entity
          AND e.event_type = (${steps}::text[])[w.step_idx + 1]
          AND e.timestamp > w.prev_ts
          AND e.timestamp <= w.deadline
      ) nxt
      WHERE w.step_idx < ${steps.length} AND nxt.next_ts IS NOT NULL
    )
    SELECT step_idx, COUNT(*) AS reached_count
    FROM walk GROUP BY step_idx ORDER BY step_idx
  `;
}

/**
 * Build the GET /funnel handler (REQUIREMENTS.md §5.4). Param errors (missing or
 * malformed steps/window, or a bad common param) become a §5.5 400 before any DB
 * call; a query failure becomes a §5.5 500 — neither crashes the host. The whole
 * funnel walk runs in Postgres (a recursive CTE), so only per-step counts cross
 * the wire. Consumed by the analytics router.
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
      const rows = (await funnelWalkQuery(sql, common, steps, windowSeconds)) as unknown as Array<{
        step_idx: number;
        reached_count: string;
      }>;

      // GROUP BY only emits rows for steps some entity reached; zero-fill the rest.
      const byStep = new Map<number, number>();
      for (const r of rows) byStep.set(Number(r.step_idx), Number(r.reached_count));
      const counts = steps.map((_, i) => byStep.get(i + 1) ?? 0);

      return c.json({
        steps: buildSteps(steps, counts),
        overall_conversion: ratio(counts[counts.length - 1] as number, counts[0] as number),
        window_seconds: windowSeconds,
        filters: buildFilters(common),
      });
    } catch (err) {
      console.warn(`[beacon] funnel query failed: ${String(err)}`);
      return errorResponse(c, 'INTERNAL_ERROR', 'failed to query funnel');
    }
  };
}
