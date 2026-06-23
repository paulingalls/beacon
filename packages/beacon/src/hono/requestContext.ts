import type { Context } from 'hono';
import { getConnInfo } from 'hono/bun';

import type { BeaconRequest } from '../adapter/beaconRequest';
import {
  type ResolvedEventFields,
  resolveEventFieldsFromRequest,
  resolveIpFromRequest,
} from '../middleware/requestContext';
import { honoToBeaconRequest } from './requestAdapter';

// Hono-Context shims over the framework-agnostic request-context cores
// (middleware/requestContext.ts). They live behind the ./hono subpath so the
// agnostic emit path never loads hono/bun; the deployed Hono host and any /hono
// consumer funnel their Context through honoRequest into the shared cores.

/** Inputs for resolveEventFields — the request-context config each Hono event path holds. */
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
 * a throwing override never propagates (the BeaconRequest.clientAddress() contract is
 * non-throwing, so the guard lives at this Context boundary, not in the cores). This
 * is the single Context→BeaconRequest bridge the Hono callers all funnel through.
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
 * Default socket-address source (Bun). Guarded — getConnInfo throws off-server.
 * The Hono-Context socket source for the Hono shims (resolveIp/resolveEventFields)
 * and host getClientAddress defaults (requestLogger, shortener/create, api/rateLimit).
 * Intentionally mirrors the inlined guard in honoToBeaconRequest; keep the two in
 * sync if either changes (§1.1).
 */
export function defaultClientAddress(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined;
  }
}
