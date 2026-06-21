import { extractAttribution, resolveEventFields } from '@pi-innovations/beacon-sdk';
import type { Context, Handler } from 'hono';
import type { Sql } from 'postgres';
import type { EventBuffer } from '../events/buffer';
import type { ShortLinkCache } from './cache';
import { incrementClickCount, type ShortLinkRecord } from './store';

/** Minimal "link not found" body for an unknown or expired code (REQUIREMENTS.md §7.2). */
const NOT_FOUND_HTML =
  '<!doctype html><html><head><title>Link not found</title></head>' +
  '<body><h1>Link not found</h1><p>This short link is invalid or has expired.</p></body></html>';

export interface RedirectOptions {
  /** Cache wrapping the store loader; resolves a live link or null. */
  cache: ShortLinkCache;
  /** Postgres client for the fire-and-forget click-count increment. */
  sql: Sql;
  /** Shared event buffer the short_link_click event is pushed to. */
  buffer: EventBuffer;
  /** SHA-256 the client IP before storage (REQUIREMENTS.md §1.1). Default true. */
  hashIPs?: boolean;
  /** Resolve the authenticated user id from the request, or null. */
  getUserId?: (c: Context) => string | null;
  /** Socket-address source when X-Forwarded-For is absent. Defaults to Bun's getConnInfo. */
  getClientAddress?: (c: Context) => string | undefined;
}

/**
 * Build the `GET /:code` redirect handler (REQUIREMENTS.md §7.2). Looks the code
 * up through the cache; an unknown or expired code returns a 404 page and logs
 * nothing. On a hit it increments the click count and logs a short_link_click
 * event — both fire-and-forget so they never block or fail the 302 (§1.3) — then
 * redirects to the destination. Only the cache lookup is awaited.
 */
export function createRedirectHandler(opts: RedirectOptions): Handler {
  return async (c) => {
    const code = c.req.param('code');
    // The `/:code` route always binds a code; the guard narrows the Hono
    // `string | undefined` param type and defends an empty match all the same.
    if (!code) {
      return c.html(NOT_FOUND_HTML, 404);
    }

    const record = await opts.cache.get(code);
    if (record === null) {
      return c.html(NOT_FOUND_HTML, 404);
    }

    // Non-blocking side effects: the counter UPDATE swallows its own errors, and
    // the event is buffered for async flush — neither delays the redirect.
    void incrementClickCount(opts.sql, code);
    logClick(c, opts, record);

    return c.redirect(record.destination, 302);
  };
}

/**
 * Push a short_link_click event for a resolved link. product_id comes from the
 * link record (a short link may belong to any product), and the link's campaign
 * is merged OVER the request URL's attribution params so campaign data wins on a
 * key collision (REQUIREMENTS.md §3.3). A throwing getUserId yields a null
 * user_id rather than propagating (§1.3, mirroring track()).
 */
function logClick(c: Context, opts: RedirectOptions, record: ShortLinkRecord): void {
  const { userId, visitorToken, platform, context } = resolveEventFields(c, {
    getUserId: opts.getUserId,
    hashIPs: opts.hashIPs,
    getClientAddress: opts.getClientAddress,
    label: 'redirect',
  });
  const attribution = { ...(extractAttribution(c.req.url) ?? {}), ...record.campaign };

  opts.buffer.push({
    productId: record.product_id,
    eventType: 'short_link_click',
    timestamp: new Date(),
    userId,
    visitorToken,
    platform,
    properties: { code: record.code, destination: record.destination },
    context,
    attribution,
  });
}
