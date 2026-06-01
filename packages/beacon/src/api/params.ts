import type { Context } from 'hono';

// Common query-parameter parsing for the query API (REQUIREMENTS.md §5.3). Every
// query endpoint except /schema accepts these five params. The parser is pure —
// it reads only `c.req.query()` and never touches the Response — so the router
// (story-007) catches QueryParamError and renders the §5.5 400 via errorResponse.

/** The platforms a request may filter by (REQUIREMENTS.md §5.3). */
const PLATFORMS = ['web', 'ios', 'android'] as const;
export type Platform = (typeof PLATFORMS)[number];

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** Parsed + validated common query parameters (REQUIREMENTS.md §5.3). */
export interface CommonQueryParams {
  /** Filter to one product; undefined spans all products. */
  productId?: string;
  /** Inclusive start of the time range. Defaults to 30 days before now. */
  after: Date;
  /** Exclusive end of the time range. Defaults to now. */
  before: Date;
  /** Filter by client platform; undefined spans all platforms. */
  platform?: Platform;
  /** Filter to one user; undefined spans all users. */
  userId?: string;
}

/**
 * Echo the applied filters in a query response (REQUIREMENTS.md §5.4): always the
 * resolved `after`, plus `product_id` only when a product filter was supplied.
 * Shared by every grouped/aggregated endpoint (aggregate, funnel, attribution)
 * so the §5.4 filters shape stays identical across them.
 */
export function buildFilters(common: CommonQueryParams): { product_id?: string; after: string } {
  return common.productId === undefined
    ? { after: common.after.toISOString() }
    : { product_id: common.productId, after: common.after.toISOString() };
}

/**
 * A rejected query parameter (REQUIREMENTS.md §5.5 INVALID_PARAMETER). Carries
 * the offending `parameter` name so the router can name it in the 400 body.
 */
export class QueryParamError extends Error {
  readonly parameter: string;
  constructor(parameter: string, message: string) {
    super(message);
    this.name = 'QueryParamError';
    this.parameter = parameter;
  }
}

/**
 * Parse and validate the §5.3 common params off the request. Throws
 * QueryParamError on a bad value (unparseable date, unknown platform, or a
 * reversed/empty range) so all five endpoints reject malformed input uniformly
 * rather than silently returning empty results. `now` is injectable for
 * deterministic tests (matches the RateLimiter/VisitorTokenStore convention).
 */
export function parseCommonParams(c: Context, now: () => number = Date.now): CommonQueryParams {
  const nowMs = now();
  const after = parseDate(queryParam(c, 'after'), 'after', new Date(nowMs - THIRTY_DAYS_MS));
  const before = parseDate(queryParam(c, 'before'), 'before', new Date(nowMs));

  // A reversed or empty range can only be a caller mistake: it yields no rows.
  // Reject it here, at the shared choke point, so agents get a clear 400.
  if (after.getTime() >= before.getTime()) {
    throw new QueryParamError('after', "'after' must be earlier than 'before'");
  }

  return {
    productId: queryParam(c, 'product_id'),
    after,
    before,
    platform: parsePlatform(queryParam(c, 'platform')),
    userId: queryParam(c, 'user_id'),
  };
}

/**
 * Read a query param, treating a present-but-blank value (`?product_id=` or
 * whitespace-only) as absent. Without this, an empty `product_id`/`user_id`
 * would pass through as a literal `''` filter — returning no rows instead of
 * spanning all products/users — and an empty `platform` would 400 confusingly.
 */
function queryParam(c: Context, key: string): string | undefined {
  const value = c.req.query(key);
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Parse an optional ISO date param, falling back to `fallback`; throw on a bad value. */
function parseDate(value: string | undefined, parameter: string, fallback: Date): Date {
  if (value === undefined) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new QueryParamError(parameter, `'${parameter}' must be an ISO 8601 date`);
  }
  return date;
}

/** Validate an optional platform param against the allowed set; throw on a bad value. */
function parsePlatform(value: string | undefined): Platform | undefined {
  if (value === undefined) return undefined;
  if (!PLATFORMS.includes(value as Platform)) {
    throw new QueryParamError('platform', `'platform' must be one of: ${PLATFORMS.join(', ')}`);
  }
  return value as Platform;
}
