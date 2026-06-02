import { createHash } from 'node:crypto';

import type { Context } from 'hono';
import { getConnInfo } from 'hono/bun';

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
 * Resolve, in one pass, the per-request fields every logged event shares: the
 * authenticated user id, the visitor token, the (optionally hashed) client IP,
 * and the transport `context` + `platform`. Extracted so the event paths that
 * build all of it in one pass (track and the redirect click logger) do so
 * identically — one home for the §1.3 failure isolation and the privacy-sensitive
 * IP handling. A throwing getUserId yields a null user id rather than propagating
 * (§1.3); `label` names the caller in that warning.
 *
 * The batch-ingest endpoint deliberately does NOT use this: it must resolve only
 * the cheap id/ip before its rate-limit gate and build `context` (the attacker-
 * controlled X-App-Context parse) only after the gate passes, so it composes the
 * underlying `resolveIp` / `buildEventContext` primitives directly instead.
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

  const visitorToken = c.get('beaconVisitorToken') ?? null;
  const ip = resolveIp(c, opts.hashIPs ?? true, opts.getClientAddress ?? defaultClientAddress);
  const { context, platform } = buildEventContext(c, ip);

  return { userId, visitorToken, ip, platform, context };
}

/**
 * Client IP per §1.1: first X-Forwarded-For token, else the socket address.
 * SHA-256 hashed when enabled. Undefined when no source yields an address.
 */
export function resolveIp(
  c: Context,
  hashIPs: boolean,
  getClientAddress: (c: Context) => string | undefined,
): string | undefined {
  const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
  // getClientAddress is host-supplied (default is internally guarded); a throw
  // from a custom override must not propagate out and crash the host (§1.3).
  let socketAddress: string | undefined;
  try {
    socketAddress = getClientAddress(c);
  } catch (err) {
    console.warn(`[beacon] getClientAddress failed: ${String(err)}`);
  }
  const ip = forwarded || socketAddress;
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
 * app_context) and resolve its `platform` from the X-App-Context header. `ip` is
 * passed in already-resolved so a caller that also needs it elsewhere (the
 * middleware seeds the visitor-token record with it) resolves it only once.
 */
export function buildEventContext(c: Context, ip: string | undefined): EventContext {
  const appContext = parseAppContext(c.req.header('x-app-context'));
  const declaredPlatform = appContext?.platform;
  const platform =
    typeof declaredPlatform === 'string' && declaredPlatform.trim() !== ''
      ? declaredPlatform
      : 'web';

  const context: Record<string, unknown> = {
    user_agent: c.req.header('user-agent'),
    referrer: c.req.header('referer'),
    accept_language: firstLocale(c.req.header('accept-language')),
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
