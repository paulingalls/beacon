import type { Context, Handler } from 'hono';
import type { Sql } from 'postgres';

import { errorResponse } from '../api/errors';

// Schema introspection endpoint (REQUIREMENTS.md §5.4 GET /analytics/schema).
// Returns the full data model so an agent with no prior knowledge can discover
// every product, event type, dimension, property key, time range, and the other
// four query endpoints. Unlike the other endpoints it takes no common params
// (§5.3). The property_keys scan is a full-table jsonb_object_keys pass, so it is
// cached in memory and refreshed on a TTL to keep it off the request hot path.

const DEFAULT_PROPERTY_KEYS_TTL_MS = 600_000; // 10 minutes (§5.4)

/** The five queryable dimensions (REQUIREMENTS.md §5.4 schema.dimensions). */
const DIMENSIONS = ['product_id', 'event_type', 'platform', 'user_id', 'visitor_token'] as const;

export interface SchemaHandlerOptions {
  /** API mount prefix, used to render the endpoints[].path values. */
  basePath: string;
  /** property_keys cache TTL in ms. Default 600000 (10 min). */
  propertyKeysTtlMs?: number;
  /** Clock injection for deterministic cache-expiry tests. Default Date.now. */
  now?: () => number;
}

/** property_keys shape: product_id -> event_type -> sorted distinct JSONB keys. */
type PropertyKeys = Record<string, Record<string, string[]>>;

interface MetaRow {
  product_id: string;
  event_type: string;
  first_seen: Date;
  last_seen: Date;
  count: string; // BIGINT arrives as a string from postgres.js
}

interface PropertyKeyRow {
  product_id: string;
  event_type: string;
  key: string;
}

/**
 * Build the GET /schema handler (REQUIREMENTS.md §5.4). The factory owns the
 * property_keys cache so its TTL window persists across requests — story-007
 * must build the handler once and reuse it (a fresh handler per request would
 * never warm the cache). A query failure becomes a §5.5 INTERNAL_ERROR 500
 * rather than crashing the host.
 */
export function createSchemaHandler(sql: Sql, opts: SchemaHandlerOptions): Handler {
  const ttlMs = opts.propertyKeysTtlMs ?? DEFAULT_PROPERTY_KEYS_TTL_MS;
  const now = opts.now ?? Date.now;
  const endpoints = buildEndpoints(opts.basePath);

  let cache: { value: PropertyKeys; fetchedAt: number } | null = null;

  async function propertyKeys(): Promise<PropertyKeys> {
    if (cache && now() - cache.fetchedAt < ttlMs) return cache.value;
    const rows = await sql<PropertyKeyRow[]>`
      SELECT DISTINCT product_id, event_type, jsonb_object_keys(properties) AS key
      FROM beacon_events`;
    cache = { value: foldPropertyKeys(rows), fetchedAt: now() };
    return cache.value;
  }

  return async (c: Context) => {
    try {
      const metaRows = await sql<MetaRow[]>`
        SELECT product_id, event_type, first_seen, last_seen, count
        FROM beacon_meta ORDER BY product_id, event_type`;
      const platformRows = await sql<{ platform: string }[]>`
        SELECT DISTINCT platform FROM beacon_events ORDER BY platform`;
      const [range] = await sql<{ earliest: Date | null; latest: Date | null }[]>`
        SELECT MIN(timestamp) AS earliest, MAX(timestamp) AS latest FROM beacon_events`;

      const products = [...new Set(metaRows.map((r) => r.product_id))];
      const event_types = metaRows.map((r) => ({
        product_id: r.product_id,
        event_type: r.event_type,
        first_seen: r.first_seen,
        last_seen: r.last_seen,
        count: Number(r.count),
      }));

      return c.json({
        products,
        event_types,
        platforms: platformRows.map((r) => r.platform),
        dimensions: [...DIMENSIONS],
        property_keys: await propertyKeys(),
        time_range: { earliest: range?.earliest ?? null, latest: range?.latest ?? null },
        endpoints,
      });
    } catch (err) {
      console.warn(`[beacon] schema query failed: ${String(err)}`);
      return errorResponse(c, 'INTERNAL_ERROR', 'failed to build schema');
    }
  };
}

/** Fold the DISTINCT (product, type, key) rows into product -> type -> [keys]. */
function foldPropertyKeys(rows: PropertyKeyRow[]): PropertyKeys {
  const out: PropertyKeys = {};
  for (const r of rows) {
    let byType = out[r.product_id];
    if (!byType) {
      byType = {};
      out[r.product_id] = byType;
    }
    let keys = byType[r.event_type];
    if (!keys) {
      keys = [];
      byType[r.event_type] = keys;
    }
    keys.push(r.key);
  }
  for (const byType of Object.values(out)) {
    for (const keys of Object.values(byType)) keys.sort();
  }
  return out;
}

/** The static endpoints descriptor (REQUIREMENTS.md §5.4), paths under basePath. */
function buildEndpoints(
  basePath: string,
): Record<string, { method: string; path: string; description: string }> {
  return {
    events: {
      method: 'GET',
      path: `${basePath}/events`,
      description: 'Filtered event stream with pagination',
    },
    aggregate: {
      method: 'GET',
      path: `${basePath}/aggregate`,
      description: 'Counts and uniques grouped by dimension',
    },
    funnel: {
      method: 'GET',
      path: `${basePath}/funnel`,
      description: 'Conversion rates through event sequences',
    },
    attribution: {
      method: 'GET',
      path: `${basePath}/attribution`,
      description: 'Campaign and source performance',
    },
  };
}
