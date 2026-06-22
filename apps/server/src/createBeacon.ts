// The DB-backed Beacon factory for the deployed server (Milestone 4: physical
// single-writer boundary). Relocated out of the published @pi-innovations/beacon-sdk
// package — the SDK now ships HTTP-emit only, and this factory (the one holder of
// central-DB write creds) lives in the private apps/server. It builds on the SDK's
// framework-agnostic capture cores + wire types and the server-internal DB modules
// (storage/, events/buffer, visitors/tokenStore) that relocated here in story-005.

import type { BufferStats } from '@pi-innovations/beacon-sdk';
import { track as trackEvent } from '@pi-innovations/beacon-sdk';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { adminGate } from './api/auth';
import { createIdentifyHandler } from './api/identify';
import { createIngestHandler } from './api/ingest';
import { RateLimiter, rateLimitGate } from './api/rateLimit';
import { createDashboardHandler } from './dashboard/index';
import { EventBuffer } from './events/buffer';
import { requestLogger } from './middleware/requestLogger';
import { createAggregateHandler } from './query/aggregate';
import { createAttributionHandler } from './query/attribution';
import { createEventsHandler } from './query/events';
import { createFunnelHandler } from './query/funnel';
import { createSchemaHandler } from './query/schema';
import { ShortLinkCache } from './shortener/cache';
import { createCreateHandler } from './shortener/create';
import { createRedirectHandler } from './shortener/redirect';
import {
  type CreatedShortLink,
  getShortLink,
  createShortLink as persistShortLink,
} from './shortener/store';
import { closeDb, createDb } from './storage/db';
import type { BeaconConfig } from './types';
import { associateVisitor } from './visitors/associate';
import { VisitorTokenStore } from './visitors/tokenStore';

/** Query-API rate-limit window: requests/min/user (REQUIREMENTS.md §5.2). */
const QUERY_RATE_WINDOW_MS = 60_000;
const DEFAULT_QUERY_RATE_LIMIT = 60;

/** Options for the programmatic Beacon.createShortLink() helper (REQUIREMENTS.md §7.2). */
export interface CreateShortLinkOptions {
  destination: string;
  productId: string;
  campaign?: Record<string, unknown>;
  expiresAt?: Date | null;
}

/** A configured Beacon instance: middleware, visitor helpers, lifecycle controls. */
export interface Beacon {
  /** Configured API mount prefix (default '/analytics'). Mount the router here:
   * `app.route(beacon.basePath, beacon.router())`. */
  basePath: string;
  /** Hono middleware that logs every request and tracks anonymous visitors. */
  middleware(): MiddlewareHandler;
  /**
   * Record a custom product event from a route handler (REQUIREMENTS.md §6.1).
   * Fire-and-forget: buffers the event and returns immediately. Throws only on an
   * invalid event_type (empty/whitespace or >100 chars).
   */
  track(c: Context, eventType: string, properties?: Record<string, unknown>): void;
  /**
   * API router with the client batch-ingest route at `{basePath}/events`
   * (REQUIREMENTS.md §6.2) — public but rate-limited. Mount relative to basePath.
   * Returns the same shared instance on every call (its RateLimiter window
   * persists across requests), so mount it once.
   */
  router(): Hono;
  /**
   * URL shortener router (REQUIREMENTS.md §7): `POST /short` (admin-gated create,
   * per-admin rate-limited) and `GET /:code` (public redirect, logs a
   * short_link_click). Returns the same shared instance on every call — its
   * LRU/TTL link cache and the create-limiter window persist across requests — so
   * mount it once, typically at the root of a dedicated short domain:
   * `app.route('/', beacon.shortener())`.
   */
  shortener(): Hono;
  /**
   * Create a short link programmatically, with no HTTP request (REQUIREMENTS.md
   * §7.2). Persists the link and returns the §7.2 link object (code, url,
   * destination, timestamps). `url` is built from `config.shortDomain`.
   */
  createShortLink(opts: CreateShortLinkOptions): Promise<CreatedShortLink>;
  /** Current event-buffer counters. */
  stats(): BufferStats;
  /** Manually flush one batch of buffered events to Postgres. */
  flush(): Promise<void>;
  /** The current request's visitor token (set by the middleware), or null. */
  getVisitorToken(c: Context): string | null;
  /** Append `?_t=`/`&_t=` to a URL using the context token (no-op without one). */
  appendToken(url: string, c: Context): string;
  /**
   * Link the anonymous visitor trail to an authenticated user (REQUIREMENTS.md
   * §2.4): back-fill user_id on the trail, copy first-touch attribution onto the
   * earliest event, and drop the token. Best-effort — never throws (§1.3).
   */
  associateVisitor(c: Context, userId: string): Promise<void>;
  /** Drain remaining events, stop the token sweep, and close Postgres. */
  shutdown(): Promise<void>;
}

/**
 * Create a Beacon: open the Postgres client, start the event buffer + visitor
 * token store, and wire the request-logging middleware (REQUIREMENTS.md §1–§3).
 *
 * Throws on missing required config — the one intentional throw. Runtime failure
 * isolation (§1.3) is handled downstream: createDb never throws and the buffer
 * retries, so a Postgres outage never crashes the host.
 */
export function createBeacon(config: BeaconConfig): Beacon {
  if (!config.productId) {
    throw new Error('[beacon] config.productId is required');
  }
  if (!config.postgres?.connectionString) {
    throw new Error('[beacon] config.postgres.connectionString is required');
  }
  if (config.productAllowlist && !config.productAllowlist.includes(config.productId)) {
    // Absent-product_id ingest defaults to config.productId, so it must be in the
    // allowlist or the cardinality bound would leak a non-allowlisted product (story-006).
    throw new Error('[beacon] config.productId must be included in config.productAllowlist');
  }

  const sql = createDb({
    connectionString: config.postgres.connectionString,
    maxConnections: config.postgres.maxConnections,
  });
  const buffer = new EventBuffer(sql, {
    flushInterval: config.flushInterval,
    maxBatchSize: config.maxBatchSize,
    maxBufferSize: config.maxBufferSize,
  });
  buffer.start();

  const tokenStore = new VisitorTokenStore({
    ttl: config.visitorTokenTTL,
    maxEntries: config.maxVisitorTokens,
  });

  const middleware = requestLogger(buffer, {
    productId: config.productId,
    getUserId: config.getUserId,
    excludePaths: config.excludePaths,
    hashIPs: config.hashIPs,
    tokenStore,
  });

  // track() and the ingest endpoint share the request-context/IP config.
  const eventOptions = {
    productId: config.productId,
    getUserId: config.getUserId,
    hashIPs: config.hashIPs,
  };

  // Build the ingest handler + router ONCE so the handler's RateLimiter window
  // persists across requests (a fresh handler per router() call would reset it).
  // The route is relative to basePath; the host mounts the sub-app there.
  const basePath = config.basePath ?? '/analytics';
  const apiRouter = new Hono();
  // The allowlist is ingest-only (track() never reads body.product_id), so add it
  // at the call site rather than to the shared eventOptions.
  apiRouter.post(
    '/events',
    createIngestHandler(buffer, {
      ...eventOptions,
      productAllowlist: config.productAllowlist,
      trustedIngestToken: config.trustedIngestToken,
    }),
  );

  // Trusted identify endpoint (REQUIREMENTS.md §2.4): the host relays a login so
  // Beacon back-fills the anonymous trail to the real user. Gated by the same M2
  // bearer as ingest (config.trustedIngestToken) and sharing the associate core
  // with Beacon.associateVisitor below — one implementation for HTTP + in-process.
  apiRouter.post(
    '/identify',
    createIdentifyHandler({
      sql,
      store: tokenStore,
      buffer,
      trustedIngestToken: config.trustedIngestToken,
    }),
  );

  // The five read endpoints (REQUIREMENTS.md §5.4), each behind the admin gate
  // (§5.1) and a per-user query rate limiter (§5.2). Built ONCE so the limiter
  // window and the schema property-keys cache persist across requests — a fresh
  // instance per request would reset both. The POST /events ingest route above
  // stays public with its own limiter; query auth/limiting is independent of it.
  const queryLimiter = new RateLimiter({
    limit: config.queryRateLimit ?? DEFAULT_QUERY_RATE_LIMIT,
    windowMs: QUERY_RATE_WINDOW_MS,
  });
  const admin = adminGate({ isAdmin: config.isAdmin });
  const limit = rateLimitGate({
    limiter: queryLimiter,
    getUserId: (c) => config.getUserId?.(c) ?? null,
    hashIPs: config.hashIPs,
  });
  apiRouter.get('/schema', admin, limit, createSchemaHandler(sql, { basePath }));
  apiRouter.get('/events', admin, limit, createEventsHandler(sql));
  apiRouter.get('/aggregate', admin, limit, createAggregateHandler(sql));
  apiRouter.get('/funnel', admin, limit, createFunnelHandler(sql));
  apiRouter.get(
    '/attribution',
    admin,
    limit,
    createAttributionHandler(sql, { channelMapping: config.channelMapping }),
  );

  // Admin dashboard (REQUIREMENTS.md §9): a server-rendered HTML page that consumes
  // the query routes above via the browser. Same admin gate as the query API; no
  // query rate limiter — the page is cheap static HTML and the data endpoints it
  // fetches are already limited. `basePath` is threaded into the page so its inline
  // script builds same-origin query URLs.
  apiRouter.get('/dashboard', admin, createDashboardHandler({ basePath }));

  // URL shortener (REQUIREMENTS.md §7). Build the link cache + router ONCE so the
  // LRU/TTL windows and the create limiter persist across requests — the same
  // build-once rationale as apiRouter above. shortDomain defaults to '' → relative
  // `/CODE` urls (usable when the shortener is mounted at a root); a host on a
  // dedicated short domain sets config.shortDomain. getUserId is wired into both
  // handlers so the per-admin create limit (§7.2) keys on the admin, not a single
  // shared bucket, and clicks attribute to the authenticated user.
  const shortDomain = config.shortDomain ?? '';
  const shortLinkCache = new ShortLinkCache({
    fetch: (code) => getShortLink(sql, code),
    size: config.shortLinkCacheSize,
    ttl: config.shortLinkCacheTTL,
  });
  const shortenerRouter = new Hono();
  shortenerRouter.post(
    '/short',
    adminGate({ isAdmin: config.isAdmin }),
    createCreateHandler({
      sql,
      shortDomain,
      getUserId: config.getUserId,
      hashIPs: config.hashIPs,
      rateLimit: { limit: config.shortLinkCreateRateLimit },
    }),
  );
  shortenerRouter.get(
    '/:code',
    createRedirectHandler({
      cache: shortLinkCache,
      sql,
      buffer,
      hashIPs: config.hashIPs,
      getUserId: config.getUserId,
    }),
  );

  const getVisitorToken = (c: Context): string | null => c.get('beaconVisitorToken') ?? null;

  return {
    basePath,
    middleware: () => middleware,
    track: (c, eventType, properties) => trackEvent(buffer, c, eventOptions, eventType, properties),
    router: () => apiRouter,
    shortener: () => shortenerRouter,
    createShortLink: (opts) => persistShortLink(sql, { ...opts, shortDomain }),
    stats: () => buffer.stats(),
    flush: () => buffer.flush(),
    getVisitorToken,
    appendToken: (url, c) => appendToken(url, getVisitorToken(c)),
    // Delegate to the shared associate core (visitors/associate.ts) so the
    // in-process path and the HTTP {basePath}/identify endpoint run one
    // implementation: drain the buffered trail, back-fill, copy first-touch
    // attribution, drop the token. Best-effort — never throws (§1.3).
    associateVisitor: (c, userId) =>
      associateVisitor(buffer, sql, tokenStore, getVisitorToken(c), userId),
    shutdown: async () => {
      tokenStore.stop();
      await buffer.stop();
      await closeDb(sql);
    },
  };
}

/** Append the visitor token to a URL, preserving any `#fragment` (§2.3). */
function appendToken(url: string, token: string | null): string {
  if (!token) return url;
  const hashIndex = url.indexOf('#');
  const base = hashIndex === -1 ? url : url.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? '' : url.slice(hashIndex);
  // Idempotent: a URL that already carries a `_t` param is returned unchanged.
  // Appending a second `_t` would make the framework pick one arbitrarily and
  // split the visitor trail, so we never double-apply.
  if (/[?&]_t=/.test(base)) return url;
  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}_t=${token}${fragment}`;
}
