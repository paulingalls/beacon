import { createHash } from 'node:crypto';

import type { Context, MiddlewareHandler } from 'hono';

import type { EventBuffer } from '../events/buffer';
import type { BeaconEvent } from '../types';

export interface RequestLoggerOptions {
  /** Product this Beacon instance logs for (beacon_events.product_id). */
  productId: string;
  /** Resolve the authenticated user id from the request, or null. */
  getUserId?: (c: Context) => string | null;
  /** Path prefixes to skip — a request is skipped when its path startsWith any. */
  excludePaths?: string[];
  /** SHA-256 the client IP before storage (REQUIREMENTS.md §1.1). Default true. */
  hashIPs?: boolean;
}

/**
 * Hono middleware that logs every request as a `request` event (REQUIREMENTS.md
 * §1.1). It times the downstream handler, captures request/transport metadata,
 * and pushes the event to the buffer synchronously after the response is built —
 * the actual Postgres write is async via the buffer, so the response is never
 * blocked (§1.2). Visitor tokens and attribution arrive in Milestone 3.
 */
export function requestLogger(buffer: EventBuffer, opts: RequestLoggerOptions): MiddlewareHandler {
  const { productId, getUserId, excludePaths = [], hashIPs = true } = opts;

  return async (c, next) => {
    const path = c.req.path;
    if (excludePaths.some((prefix) => path.startsWith(prefix))) {
      await next();
      return;
    }

    const start = Date.now();
    try {
      await next();
    } finally {
      // Log in finally so the event survives even when a downstream error
      // propagates past this middleware (e.g. a host app.onError that rethrows).
      // In that path Hono leaves c.res at its 200 default but sets c.error, so
      // fall back to 500 to avoid mislabelling a failed request as a success.
      //
      // The whole logging step is guarded: a failure here (e.g. a throwing
      // user-supplied getUserId) must never crash the host or mask a
      // propagating handler error (§1.3 failure isolation — Beacon never
      // crashes the host app).
      try {
        const responseTimeMs = Date.now() - start;
        const status = c.error ? 500 : c.res.status;
        buffer.push(buildEvent(c, { productId, getUserId, hashIPs, path, responseTimeMs, status }));
      } catch (err) {
        console.warn(`[beacon] request logging failed: ${String(err)}`);
      }
    }
  };
}

interface BuildArgs {
  productId: string;
  getUserId?: (c: Context) => string | null;
  hashIPs: boolean;
  path: string;
  responseTimeMs: number;
  status: number;
}

function buildEvent(c: Context, args: BuildArgs): BeaconEvent {
  const { productId, getUserId, hashIPs, path, responseTimeMs, status } = args;

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
    ip: clientIp(c.req.header('x-forwarded-for'), hashIPs),
  };
  if (appContext) context.app_context = appContext;

  return {
    productId,
    eventType: 'request',
    userId: getUserId?.(c) ?? null,
    platform,
    properties: {
      path,
      method: c.req.method,
      status,
      response_time_ms: responseTimeMs,
    },
    context,
  };
}

/** First comma-separated x-forwarded-for token, SHA-256 hashed when enabled. */
function clientIp(forwardedFor: string | undefined, hashIPs: boolean): string | undefined {
  const ip = forwardedFor?.split(',')[0]?.trim();
  if (!ip) return undefined;
  return hashIPs ? createHash('sha256').update(ip).digest('hex') : ip;
}

/** First locale only, per §1.1 (e.g. "en-US,en;q=0.9" -> "en-US"). */
function firstLocale(acceptLanguage: string | undefined): string | undefined {
  return acceptLanguage?.split(',')[0]?.trim() || undefined;
}

/** Parse the X-App-Context JSON header; malformed JSON is silently ignored. */
function parseAppContext(header: string | undefined): Record<string, unknown> | undefined {
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
