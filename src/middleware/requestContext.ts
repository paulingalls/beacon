import { createHash } from 'node:crypto';

import type { Context } from 'hono';
import { getConnInfo } from 'hono/bun';

import { type BeaconRequest, honoToBeaconRequest } from '../adapter/beaconRequest';

// Shared request-context builder (REQUIREMENTS.md §1.1, §3.1 event-schema split).
// Extracted from the request-logging middleware so the server-side track() helper
// builds an event `context` identically — one source for the privacy-sensitive IP
// hashing, so the two can never diverge. HTTP details (path/method/status) stay in
// each caller's `properties`; transport/client metadata lives in `context` here.

/** The transport/client `context` of an event, plus the resolved platform. */
export interface EventContext {
  context: Record<string, unknown>;
  platform: string;
}

/** Everything an event needs about its request, resolved in one pass. */
export interface ResolvedEventFields {
  /** Authenticated user id, or null (also null when getUserId throws — §1.3). */
  userId: string | null;
  /** Visitor token the middleware put on the context, or null. */
  visitorToken: string | null;
  /** Resolved (optionally hashed) client IP, or undefined when none. */
  ip: string | undefined;
  /** Platform from X-App-Context, defaulting to 'web'. */
  platform: string;
  /** Transport/client context (UA, referrer, accept-language, ip, app_context). */
  context: Record<string, unknown>;
}

/** Inputs for resolveEventFields — the request-context config each event path holds. */
export interface ResolveEventFieldsOptions {
  /** Resolve the authenticated user id from the request, or null. */
  getUserId?: (c: Context) => string | null;
  /** SHA-256 the client IP before storage (REQUIREMENTS.md §1.1). Default true. */
  hashIPs?: boolean;
  /** Socket-address source when X-Forwarded-For is absent. Default Bun's getConnInfo. */
  getClientAddress?: (c: Context) => string | undefined;
  /** Names the caller in the getUserId-failure warning (e.g. 'track', 'redirect', 'ingest'). */
  label: string;
}

/**
 * Adapt a Hono Context to a BeaconRequest, optionally overriding the socket-address
 * source. honoToBeaconRequest hard-codes `getConnInfo`; a host or test that supplies
 * a custom `getClientAddress` needs it re-injected here, wrapped in the §1.3 guard so
 * a throwing override never propagates (the new `BeaconRequest.clientAddress()`
 * contract is non-throwing, so the guard lives at this Context boundary, not in the
 * cores). This is the single Context→BeaconRequest bridge the capture layer and the
 * Hono shims below all funnel through.
 */
export function honoRequest(
  c: Context,
  getClientAddress?: (c: Context) => string | undefined,
): BeaconRequest {
  const base = honoToBeaconRequest(c);
  if (!getClientAddress) return base;
  return {
    ...base,
    clientAddress: () => {
      try {
        return getClientAddress(c);
      } catch (err) {
        console.warn(`[beacon] getClientAddress failed: ${String(err)}`);
        return undefined;
      }
    },
  };
}

/**
 * Resolve, in one pass, the per-request fields every logged event shares: the
 * visitor token, the (optionally hashed) client IP, and the transport `context` +
 * `platform`. The framework-agnostic core — it reads everything off a BeaconRequest
 * so the same logic serves the Hono host and a Bun.serve product (story-003). The
 * authenticated `userId` is resolved by the caller (which holds the host-specific
 * auth source) and passed in: `getUserId` is a Hono-`Context` callback and the §1.3
 * failure isolation around it is inherently a Context concern, so it stays at the
 * caller, not here.
 *
 * The batch-ingest endpoint deliberately does NOT use this: it must resolve only
 * the cheap id/ip before its rate-limit gate and build `context` (the attacker-
 * controlled X-App-Context parse) only after the gate passes, so it composes the
 * underlying `resolveIpFromRequest` / `buildEventContext` primitives directly.
 */
export function resolveEventFieldsFromRequest(
  req: BeaconRequest,
  opts: { userId: string | null; hashIPs?: boolean },
): ResolvedEventFields {
  const visitorToken = req.getToken();
  const ip = resolveIpFromRequest(req, opts.hashIPs ?? true);
  const { context, platform } = buildEventContext(req, ip);

  return { userId: opts.userId, visitorToken, ip, platform, context };
}

/**
 * Hono-Context shim for `resolveEventFieldsFromRequest`, kept for the shortener
 * redirect click logger (the one remaining Hono-only caller). Resolves `userId` via
 * the host `getUserId` callback inside the §1.3 guard (`label` names the caller in
 * the warning), then delegates to the core through `honoRequest`.
 */
export function resolveEventFields(
  c: Context,
  opts: ResolveEventFieldsOptions,
): ResolvedEventFields {
  let userId: string | null = null;
  try {
    userId = opts.getUserId?.(c) ?? null;
  } catch (err) {
    console.warn(`[beacon] ${opts.label}: getUserId failed: ${String(err)}`);
  }

  return resolveEventFieldsFromRequest(honoRequest(c, opts.getClientAddress), {
    userId,
    hashIPs: opts.hashIPs,
  });
}

/**
 * Client IP per §1.1: first X-Forwarded-For token, else the socket address
 * (`req.clientAddress()`). SHA-256 hashed when enabled; undefined when no source
 * yields an address. The framework-agnostic core — both the §1.3 guard and the
 * socket lookup live in the BeaconRequest adapter (and `honoRequest` for the
 * Context override), so this reads `req.clientAddress()` directly with no try/catch.
 */
export function resolveIpFromRequest(req: BeaconRequest, hashIPs: boolean): string | undefined {
  const forwarded = req.header('x-forwarded-for')?.split(',')[0]?.trim();
  return hashIp(forwarded || req.clientAddress(), hashIPs);
}

/**
 * Hono-Context shim for `resolveIpFromRequest`, kept for the Hono-only callers that
 * key a rate limiter off the client IP (shortener create, query rate-limit gate).
 * Threads the host `getClientAddress` override through `honoRequest`.
 */
export function resolveIp(
  c: Context,
  hashIPs: boolean,
  getClientAddress: (c: Context) => string | undefined,
): string | undefined {
  return resolveIpFromRequest(honoRequest(c, getClientAddress), hashIPs);
}

/**
 * SHA-256 a client IP for storage (§1.1) when `hashIPs` is on; an undefined ip
 * passes through as undefined. The one home for IP hashing — both `resolveIp` and
 * the trusted-ingest per-event context path (api/ingest.ts) route through here so
 * the privacy-sensitive hashing can never diverge.
 */
export function hashIp(ip: string | undefined, hashIPs: boolean): string | undefined {
  if (!ip) return undefined;
  return hashIPs ? createHash('sha256').update(ip).digest('hex') : ip;
}

/** Default socket-address source (Bun). Guarded — getConnInfo throws off-server. */
export function defaultClientAddress(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined;
  }
}

/**
 * Build an event's transport `context` (UA, referrer, accept-language, ip, optional
 * app_context) and resolve its `platform` from the X-App-Context header, reading off
 * a BeaconRequest. `ip` is passed in already-resolved so a caller that also needs it
 * elsewhere (the middleware seeds the visitor-token record with it) resolves it once.
 */
export function buildEventContext(req: BeaconRequest, ip: string | undefined): EventContext {
  const appContext = parseAppContext(req.header('x-app-context'));
  const declaredPlatform = appContext?.platform;
  const platform =
    typeof declaredPlatform === 'string' && declaredPlatform.trim() !== ''
      ? declaredPlatform
      : 'web';

  const context: Record<string, unknown> = {
    user_agent: req.header('user-agent'),
    referrer: req.header('referer'),
    accept_language: firstLocale(req.header('accept-language')),
    ip,
  };
  if (appContext) context.app_context = appContext;

  return { context, platform };
}

/** First locale only, per §1.1 (e.g. "en-US,en;q=0.9" -> "en-US"). */
export function firstLocale(acceptLanguage: string | undefined): string | undefined {
  return acceptLanguage?.split(',')[0]?.trim() || undefined;
}

/** Parse the X-App-Context JSON header; malformed JSON is silently ignored. */
export function parseAppContext(header: string | undefined): Record<string, unknown> | undefined {
  if (!header) return undefined;
  try {
    const parsed: unknown = JSON.parse(header);
    // Accept only a plain JSON object — arrays and primitives are not valid
    // app context and are silently ignored, like malformed JSON.
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
