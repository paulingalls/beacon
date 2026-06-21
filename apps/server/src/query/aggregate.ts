import { errorResponse } from '@pi-innovations/beacon/internal/api/errors';
import type { CommonQueryParams } from '@pi-innovations/beacon/internal/api/params';
import {
  buildFilters,
  parseCommonParams,
  QueryParamError,
} from '@pi-innovations/beacon/internal/api/params';
import type { Context, Handler } from 'hono';
import type { Sql } from 'postgres';

// Aggregate metric endpoint (REQUIREMENTS.md §5.4 GET /analytics/aggregate).
// Accepts the §5.3 common params plus event_type / metric / group_by, and
// returns either a single scalar (ungrouped) or top-100 / chronological buckets
// (grouped). Metric and group_by are closed whitelists validated before any DB
// call so a bad value is a §5.5 400, never a 500 at the SQL layer.

/** The aggregation metrics (REQUIREMENTS.md §5.4). */
const METRICS = ['count', 'unique_users', 'unique_visitors'] as const;
export type Metric = (typeof METRICS)[number];

/** Dimension columns a query may group by (REQUIREMENTS.md §5.3 common dims). */
const DIMENSIONS = ['product_id', 'event_type', 'platform', 'user_id', 'visitor_token'] as const;
type Dimension = (typeof DIMENSIONS)[number];

/** Time-bucket units, truncated via date_trunc (REQUIREMENTS.md §5.4). */
const TIME_BUCKETS = ['day', 'hour', 'week', 'month'] as const;
type TimeBucket = (typeof TIME_BUCKETS)[number];

/** A resolved group_by: a dimension column or a date_trunc time unit. */
export type GroupBy = { kind: 'dimension'; value: Dimension } | { kind: 'time'; value: TimeBucket };

/**
 * Parse the `metric` param: defaults to `count`, must be one of the §5.4
 * metrics. A blank value is treated as absent (story-001 blank-normalization).
 * Throws QueryParamError (→ 400) on an unknown value.
 */
export function parseMetric(raw: string | undefined): Metric {
  if (raw === undefined || raw.trim() === '') return 'count';
  const value = raw.trim();
  if (!METRICS.includes(value as Metric)) {
    throw new QueryParamError('metric', `'metric' must be one of: ${METRICS.join(', ')}`);
  }
  return value as Metric;
}

/**
 * Parse the optional `group_by` param against the dimension + time-bucket
 * whitelists. Returns null when absent/blank. Throws QueryParamError (→ 400) on
 * any other value — the message lists every allowed value so an agent can
 * self-correct without reading the schema endpoint.
 */
export function parseGroupBy(raw: string | undefined): GroupBy | null {
  if (raw === undefined || raw.trim() === '') return null;
  const value = raw.trim();
  if (DIMENSIONS.includes(value as Dimension))
    return { kind: 'dimension', value: value as Dimension };
  if (TIME_BUCKETS.includes(value as TimeBucket))
    return { kind: 'time', value: value as TimeBucket };
  throw new QueryParamError(
    'group_by',
    `'group_by' must be one of: ${[...DIMENSIONS, ...TIME_BUCKETS].join(', ')}`,
  );
}

/**
 * The SQL aggregate expression for a metric. The metric is a closed whitelist
 * value (never caller text), so the fixed column references are safe. NULL
 * user_ids are excluded by COUNT(DISTINCT …) automatically; unique_visitors
 * falls back to visitor_token so anonymous traffic still counts once.
 */
function metricExpr(sql: Sql, metric: Metric) {
  switch (metric) {
    case 'count':
      return sql`COUNT(*)`;
    case 'unique_users':
      return sql`COUNT(DISTINCT user_id)`;
    case 'unique_visitors':
      return sql`COUNT(DISTINCT COALESCE(user_id, visitor_token))`;
  }
}

/** postgres.js returns BIGINT counts as strings; coerce to a JSON number. */
function toCount(value: unknown): number {
  return Number(value);
}

/**
 * Build the GET /aggregate handler (REQUIREMENTS.md §5.4). Param errors (bad
 * common param, metric, or group_by) become a §5.5 400 before any DB call; a
 * query failure becomes a §5.5 500 — neither crashes the host. Consumed by the
 * story-007 router.
 */
export function createAggregateHandler(sql: Sql): Handler {
  return async (c: Context) => {
    let common: CommonQueryParams;
    let eventType: string | undefined;
    let metric: Metric;
    let groupBy: GroupBy | null;
    try {
      common = parseCommonParams(c);
      const rawType = c.req.query('event_type');
      eventType = rawType && rawType.trim() !== '' ? rawType.trim() : undefined;
      metric = parseMetric(c.req.query('metric'));
      groupBy = parseGroupBy(c.req.query('group_by'));
    } catch (err) {
      if (err instanceof QueryParamError) {
        return errorResponse(c, 'INVALID_PARAMETER', err.message, err.parameter);
      }
      throw err;
    }

    try {
      // Shared filter fragment, composed exactly as events.ts does so every
      // value is parameterized by postgres.js. Time range is always present
      // (§5.3 defaults); product_id / event_type / platform / user_id are
      // conditional.
      let where = sql`WHERE timestamp >= ${common.after} AND timestamp < ${common.before}`;
      if (common.productId) where = sql`${where} AND product_id = ${common.productId}`;
      if (eventType) where = sql`${where} AND event_type = ${eventType}`;
      if (common.platform) where = sql`${where} AND platform = ${common.platform}`;
      if (common.userId) where = sql`${where} AND user_id = ${common.userId}`;

      const value = metricExpr(sql, metric);
      const filters = buildFilters(common);

      if (groupBy === null) {
        const [row] = (await sql`
          SELECT ${value} AS value FROM beacon_events ${where}`) as unknown as { value: unknown }[];
        return c.json({ metric, value: toCount(row?.value), filters });
      }

      if (groupBy.kind === 'dimension') {
        // The dimension is a whitelist value, but a column name can't be a bound
        // parameter — use postgres.js identifier interpolation, never string
        // concatenation. Top 100 groups by value, descending (§5.4). The `key`
        // tiebreak makes the LIMIT-100 truncation deterministic: without it,
        // groups tied on value at the boundary survive arbitrarily run-to-run.
        const dim = sql(groupBy.value);
        const rows = (await sql`
          SELECT ${dim} AS key, ${value} AS value
          FROM beacon_events ${where}
          GROUP BY ${dim}
          ORDER BY value DESC, key
          LIMIT 100`) as unknown as { key: string | null; value: unknown }[];
        return c.json({
          metric,
          group_by: groupBy.value,
          groups: rows.map((r) => ({ key: r.key, value: toCount(r.value) })),
          filters,
        });
      }

      // Time bucket: date_trunc with a bound unit (a string literal, safely a
      // parameter). Chronological, no limit (§5.4). The bucket key is a
      // timestamptz; serialise it as an ISO string for an unambiguous, unit-
      // agnostic key (the §5.4 day example abbreviates, but ISO also carries the
      // time component hour buckets need).
      const unit = groupBy.value;
      const rows = (await sql`
        SELECT date_trunc(${unit}, timestamp) AS key, ${value} AS value
        FROM beacon_events ${where}
        GROUP BY 1
        ORDER BY 1 ASC`) as unknown as { key: Date | null; value: unknown }[];
      return c.json({
        metric,
        group_by: unit,
        groups: rows.map((r) => ({
          key: r.key === null ? null : r.key.toISOString(),
          value: toCount(r.value),
        })),
        filters,
      });
    } catch (err) {
      console.warn(`[beacon] aggregate query failed: ${String(err)}`);
      return errorResponse(c, 'INTERNAL_ERROR', 'failed to aggregate events');
    }
  };
}
