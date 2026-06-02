import type { Context, Handler } from 'hono';
import type { Sql } from 'postgres';

import { errorResponse } from '../api/errors';
import { applyRateLimit, RateLimiter } from '../api/rateLimit';
import { defaultClientAddress, resolveIp } from '../middleware/requestContext';
import { createShortLink, isHttpUrl } from './store';

/** Default create limit: 100 link creations per hour per admin (REQUIREMENTS.md §7.2). */
const DEFAULT_CREATE_LIMIT = 100;
const CREATE_WINDOW_MS = 60 * 60 * 1000;

export interface CreateOptions {
  /** Postgres client the link is persisted through. */
  sql: Sql;
  /** Short URL base (e.g. https://pi.ink) used to build the returned `url`. */
  shortDomain: string;
  /** Resolve the authenticated admin id for per-user rate-limit keying, or null. */
  getUserId?: (c: Context) => string | null;
  /** Hash the IP fallback rate-limit key. Default true. */
  hashIPs?: boolean;
  /** Socket-address source when X-Forwarded-For is absent. Default Bun's getConnInfo. */
  getClientAddress?: (c: Context) => string | undefined;
  /** Rate-limit tuning. Default 100 creations per hour per admin (§7.2). */
  rateLimit?: { limit?: number; windowMs?: number; now?: () => number };
}

/**
 * Build the `POST /short` create handler (REQUIREMENTS.md §7.2). Validates the
 * JSON body, rate-limits creation per admin (the factory owns one RateLimiter so
 * the window persists across requests, mirroring the ingest endpoint), persists
 * via createShortLink, and returns 201 with the §7.2 link object. Admin gating is
 * applied separately by adminGate at the mount (story-006), as the query routes do.
 * All errors use the §5.5 shape.
 */
export function createCreateHandler(opts: CreateOptions): Handler {
  const limiter = new RateLimiter({
    limit: opts.rateLimit?.limit ?? DEFAULT_CREATE_LIMIT,
    windowMs: opts.rateLimit?.windowMs ?? CREATE_WINDOW_MS,
    now: opts.rateLimit?.now,
  });
  const hashIPs = opts.hashIPs ?? true;
  const getClientAddress = opts.getClientAddress ?? defaultClientAddress;

  return async (c) => {
    // Rate-limit per admin (fallback IP, then a shared key) BEFORE reading the
    // body. getUserId is host-supplied — a throw must not crash the host (§1.3).
    let userId: string | null = null;
    try {
      userId = opts.getUserId?.(c) ?? null;
    } catch (err) {
      console.warn(`[beacon] create: getUserId failed: ${String(err)}`);
    }
    const ip = resolveIp(c, hashIPs, getClientAddress);
    const identifier = userId ?? ip ?? 'unknown';

    // Check BEFORE reading the body so an over-limit caller is rejected without us
    // parsing a (possibly large) body. Keep this ordering — a test asserts a
    // second over-limit POST is 429, not a downstream error (concern 85313d1cbe9c).
    const denied = applyRateLimit(
      c,
      limiter,
      identifier,
      'short link creation rate limit exceeded; retry later',
    );
    if (denied) return denied;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 'INVALID_PARAMETER', 'request body must be valid JSON', 'body');
    }
    // A present body must be a JSON object. A primitive/array is valid JSON but
    // the wrong shape (§5.5 INVALID_PARAMETER), distinct from an absent body
    // (null/undefined → {}) which falls through to MISSING_PARAMETER below.
    if (body !== undefined && body !== null && (typeof body !== 'object' || Array.isArray(body))) {
      return errorResponse(c, 'INVALID_PARAMETER', 'request body must be a JSON object', 'body');
    }
    const fields = (body ?? {}) as Record<string, unknown>;

    const destination = fields.destination;
    if (destination === undefined || destination === null || destination === '') {
      return errorResponse(c, 'MISSING_PARAMETER', "missing 'destination'", 'destination');
    }
    if (typeof destination !== 'string' || !isHttpUrl(destination)) {
      return errorResponse(
        c,
        'INVALID_PARAMETER',
        "'destination' must be a valid http(s) URL",
        'destination',
      );
    }

    const productId = fields.product_id;
    if (productId === undefined || productId === null || productId === '') {
      return errorResponse(c, 'MISSING_PARAMETER', "missing 'product_id'", 'product_id');
    }
    if (typeof productId !== 'string') {
      return errorResponse(c, 'INVALID_PARAMETER', "'product_id' must be a string", 'product_id');
    }

    let campaign: Record<string, unknown> | undefined;
    if (fields.campaign !== undefined) {
      if (
        typeof fields.campaign !== 'object' ||
        fields.campaign === null ||
        Array.isArray(fields.campaign)
      ) {
        return errorResponse(c, 'INVALID_PARAMETER', "'campaign' must be an object", 'campaign');
      }
      campaign = fields.campaign as Record<string, unknown>;
    }

    let expiresAt: Date | undefined;
    if (fields.expires_at !== undefined && fields.expires_at !== null) {
      if (typeof fields.expires_at !== 'string') {
        return errorResponse(
          c,
          'INVALID_PARAMETER',
          "'expires_at' must be an ISO date string",
          'expires_at',
        );
      }
      const parsed = new Date(fields.expires_at);
      if (Number.isNaN(parsed.getTime())) {
        return errorResponse(
          c,
          'INVALID_PARAMETER',
          "'expires_at' must be a valid date",
          'expires_at',
        );
      }
      expiresAt = parsed;
    }

    try {
      const link = await createShortLink(opts.sql, {
        destination,
        productId,
        campaign,
        expiresAt,
        shortDomain: opts.shortDomain,
      });
      return c.json(link, 201);
    } catch (err) {
      console.warn(`[beacon] create: createShortLink failed: ${String(err)}`);
      return errorResponse(c, 'INTERNAL_ERROR', 'failed to create short link');
    }
  };
}
