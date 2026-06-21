// First-party Beacon host app (sprint-012 / Milestone 4). Wires createBeacon from the
// environment and serves Beacon's four surfaces — ingest (REQUIREMENTS.md §6.2), query API
// (§5), dashboard (§9), and the URL shortener (§7) — plus a DB-free /health probe for the
// reverse proxy / load balancer (§1.3 outage-degrade). Config follows REQUIREMENTS.md §10.
// This is the entry point the systemd unit (deploy/beacon.service) and Dockerfile invoke.

import { verifyTrustedBearer } from '@pi-innovations/beacon';
import { type Context, Hono } from 'hono';
import { type Beacon, createBeacon } from './createBeacon';

/** Environment the host reads (a subset of process.env, injected for testability). */
export interface ServerEnv {
  /** Postgres connection string. Required — the one intentional fail-fast. */
  DATABASE_URL?: string;
  /** Bearer token gating the dashboard + query API. Unset ⇒ those surfaces fail closed. */
  ADMIN_TOKEN?: string;
  /**
   * Bearer secret authorizing a trusted s2s caller to assert per-event user_id/context
   * in the ingest body (M2). Unset ⇒ trusted ingest disabled (anonymous-only, fail-closed).
   */
  TRUSTED_INGEST_TOKEN?: string;
  /** API mount prefix. Default '/analytics'. */
  BASE_PATH?: string;
  /** Fallback product_id for events whose batch omits one. Default 'beacon'. */
  PRODUCT_ID?: string;
  /** Comma-separated allowlist of accepted product_ids (opt-in). Unset ⇒ accept any. */
  PRODUCT_ALLOWLIST?: string;
  /** Absolute base for generated short URLs, e.g. 'https://pi.ink'. */
  SHORT_DOMAIN?: string;
}

/**
 * Build the constant-time admin predicate for createBeacon's isAdmin gate.
 *
 * Delegates to the package's audited `verifyTrustedBearer` (one constant-time bearer
 * compare for the whole stack): it SHA-256s both sides and timingSafeEqual-compares, and
 * is fail-closed on an unset token — so with no ADMIN_TOKEN every request is non-admin and
 * the dashboard + query API stay unreachable rather than open.
 */
function makeIsAdmin(adminToken: string | undefined): (c: Context) => boolean {
  return (c) => verifyTrustedBearer(c.req.header('authorization'), adminToken);
}

/** Parse the comma-separated PRODUCT_ALLOWLIST env into a trimmed, non-empty list. */
function parseAllowlist(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return list.length > 0 ? list : undefined;
}

/**
 * Assemble the host Hono app and its Beacon instance from the environment. Returned
 * (rather than served) so tests can drive it via app.fetch without binding a port.
 *
 * Route order is load-bearing: /health and the query router mount BEFORE the shortener's
 * root `GET /:code`, which is a single-segment catch-all that would otherwise shadow them.
 * The request-logging middleware is intentionally not mounted — this host serves none of
 * its own content pages, so it would only log noise.
 */
export function buildServer(env: ServerEnv): { app: Hono; beacon: Beacon } {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('[server] DATABASE_URL is required');
  }

  const allowlist = parseAllowlist(env.PRODUCT_ALLOWLIST);
  const beacon = createBeacon({
    productId: env.PRODUCT_ID ?? 'beacon',
    postgres: { connectionString },
    isAdmin: makeIsAdmin(env.ADMIN_TOKEN),
    trustedIngestToken: env.TRUSTED_INGEST_TOKEN,
    basePath: env.BASE_PATH ?? '/analytics',
    shortDomain: env.SHORT_DOMAIN,
    hashIPs: true,
    ...(allowlist ? { productAllowlist: allowlist } : {}),
  });

  const app = new Hono();
  // /health must not touch Postgres (REQUIREMENTS §1.3 outage-degrade); register first so
  // the shortener catch-all below never claims it.
  app.get('/health', (c) => c.json({ status: 'ok' }));
  app.route(beacon.basePath, beacon.router());
  app.route('/', beacon.shortener());

  return { app, beacon };
}

// Production entry: read process.env, serve, and drain on shutdown so the systemd SIGTERM
// during a deploy/restart flushes buffered events before the process exits.
if (import.meta.main) {
  const { app, beacon } = buildServer(process.env as ServerEnv);
  const port = Number(process.env.PORT ?? 8080);
  const server = Bun.serve({ port, fetch: app.fetch });
  console.log(`[server] listening on :${port}`);

  const shutdown = async () => {
    await beacon.shutdown();
    await server.stop();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
