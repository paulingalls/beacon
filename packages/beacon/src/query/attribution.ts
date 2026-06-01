import type { Context, Handler } from 'hono';
import type { Sql } from 'postgres';

import { errorResponse } from '../api/errors';
import { type CommonQueryParams, parseCommonParams, QueryParamError } from '../api/params';

// Campaign/source performance endpoint (REQUIREMENTS.md §5.4 GET /analytics/attribution).
// Groups attributed events by a UTM dimension (or a derived `channel`), counting
// clicks (events carrying the grouping key) and conversions (distinct users who
// also fired the conversion_event in range). Events without the grouping key are
// excluded entirely. Consumed by the story-007 router.

const DEFAULT_GROUP_BY = 'utm_source';
const DEFAULT_CONVERSION_EVENT = 'signup';

/** The UTM dimensions a request may group by directly (REQUIREMENTS.md §5.4). */
const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const;
/** All allowed group_by values: the UTM keys plus the derived `channel`. */
const GROUP_BY_VALUES = [...UTM_KEYS, 'channel'] as const;
type GroupBy = (typeof GROUP_BY_VALUES)[number];

/** The utm_source key that `channel` is derived from (REQUIREMENTS.md §5.4). */
const CHANNEL_SOURCE_KEY = 'utm_source';

export interface AttributionHandlerOptions {
  /**
   * Channel category → member sources (REQUIREMENTS.md §5.4 / §10), e.g.
   * `{ paid: ['google', 'bing'], social: ['twitter'] }`. The handler INVERTS
   * this into a source→category CASE for `group_by=channel`; any source not
   * listed (and every source when this is absent) falls into `other`.
   */
  channelMapping?: Record<string, string[]>;
}

/** A grouping row as selected; the two counts arrive as BIGINT strings. */
interface GroupRow {
  key: string;
  clicks: string;
  conversions: string;
}

/**
 * Parse the `group_by` param: default `utm_source`, blank treated as absent
 * (story-001 convention). Throws QueryParamError (→ 400) on an out-of-set value.
 */
export function parseGroupBy(raw: string | undefined): GroupBy {
  if (raw === undefined || raw.trim() === '') return DEFAULT_GROUP_BY;
  const value = raw.trim();
  if (!(GROUP_BY_VALUES as readonly string[]).includes(value)) {
    throw new QueryParamError(
      'group_by',
      `'group_by' must be one of: ${GROUP_BY_VALUES.join(', ')}`,
    );
  }
  return value as GroupBy;
}

/** Parse the `conversion_event` param: default `signup`, blank treated as absent. */
export function parseConversionEvent(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === '') return DEFAULT_CONVERSION_EVENT;
  return raw.trim();
}

/**
 * Build the GET /attribution handler (REQUIREMENTS.md §5.4). Param errors (bad
 * common param or out-of-set group_by) become a §5.5 400 before any DB call; a
 * query failure becomes a §5.5 500 — neither crashes the host.
 */
export function createAttributionHandler(sql: Sql, opts: AttributionHandlerOptions = {}): Handler {
  const channelMapping = opts.channelMapping ?? {};

  return async (c: Context) => {
    let common: CommonQueryParams;
    let groupBy: GroupBy;
    let conversionEvent: string;
    try {
      common = parseCommonParams(c);
      groupBy = parseGroupBy(c.req.query('group_by'));
      conversionEvent = parseConversionEvent(c.req.query('conversion_event'));
    } catch (err) {
      if (err instanceof QueryParamError) {
        return errorResponse(c, 'INVALID_PARAMETER', err.message, err.parameter);
      }
      throw err;
    }

    // `channel` is derived from utm_source; every other dimension groups on its
    // own key. The grouping-key expression differs, but the "key must be present"
    // filter always reads the underlying UTM key, so events lacking it are excluded.
    const utmKey = groupBy === 'channel' ? CHANNEL_SOURCE_KEY : groupBy;
    const groupKeyExpr =
      groupBy === 'channel' ? channelCaseExpr(sql, channelMapping) : sql`attribution->>${utmKey}`;

    try {
      // The conversion cohort: distinct users who fired the conversion_event
      // within the product + time scope. Platform/user_id click filters are NOT
      // applied here — a user attributed by a click counts as a conversion if
      // they converted at all in range, regardless of the converting event's
      // platform (the click defines the attributed cohort, §5.4).
      let converters = sql`
        SELECT DISTINCT user_id FROM beacon_events
        WHERE event_type = ${conversionEvent}
          AND user_id IS NOT NULL
          AND timestamp >= ${common.after} AND timestamp < ${common.before}`;
      if (common.productId) converters = sql`${converters} AND product_id = ${common.productId}`;

      let groups = sql`
        SELECT ${groupKeyExpr} AS key,
               COUNT(*) AS clicks,
               COUNT(DISTINCT user_id) FILTER (
                 WHERE user_id IN (SELECT user_id FROM converters)
               ) AS conversions
        FROM beacon_events
        WHERE attribution->>${utmKey} IS NOT NULL
          AND timestamp >= ${common.after} AND timestamp < ${common.before}`;
      if (common.productId) groups = sql`${groups} AND product_id = ${common.productId}`;
      if (common.platform) groups = sql`${groups} AND platform = ${common.platform}`;
      if (common.userId) groups = sql`${groups} AND user_id = ${common.userId}`;
      groups = sql`${groups} GROUP BY key ORDER BY clicks DESC, key`;

      const rows =
        (await sql`WITH converters AS (${converters}) ${groups}`) as unknown as GroupRow[];

      return c.json({
        group_by: groupBy,
        conversion_event: conversionEvent,
        groups: rows.map((r) => {
          const clicks = Number(r.clicks);
          const conversions = Number(r.conversions);
          return {
            key: r.key,
            clicks,
            conversions,
            conversion_rate: clicks === 0 ? 0 : conversions / clicks,
          };
        }),
        filters: buildFilters(common),
      });
    } catch (err) {
      console.warn(`[beacon] attribution query failed: ${String(err)}`);
      return errorResponse(c, 'INTERNAL_ERROR', 'failed to query attribution');
    }
  };
}

/**
 * Invert the category→[sources] mapping into a source→category CASE over
 * utm_source. First matching category wins; unmapped sources fall to `other`.
 * Postgres rejects a CASE with no WHEN, so an empty/unconfigured mapping
 * collapses to the constant `'other'` — every attributed source buckets there.
 */
function channelCaseExpr(sql: Sql, mapping: Record<string, string[]>) {
  const entries = Object.entries(mapping).filter(([, sources]) => sources && sources.length > 0);
  if (entries.length === 0) return sql`'other'`;
  let expr = sql`CASE`;
  for (const [category, sources] of entries) {
    expr = sql`${expr} WHEN attribution->>${CHANNEL_SOURCE_KEY} IN ${sql(sources)} THEN ${category}`;
  }
  return sql`${expr} ELSE 'other' END`;
}

/** Echo the applied filters (§5.4): always `after`, plus `product_id` when set. */
function buildFilters(common: CommonQueryParams): { product_id?: string; after: string } {
  const filters: { product_id?: string; after: string } = { after: common.after.toISOString() };
  if (common.productId) filters.product_id = common.productId;
  return filters;
}
