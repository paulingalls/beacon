import { createHash, timingSafeEqual } from 'node:crypto';

import type { Context, MiddlewareHandler } from 'hono';

import { errorResponse } from './errors';

// Admin gate for the query API (REQUIREMENTS.md §5.1). Every query endpoint
// mounts this ahead of its handler; a non-admin caller gets a §5.5 UNAUTHORIZED
// 403 and the downstream handler never runs.

export interface AdminGateOptions {
  /**
   * Decide whether the request is from an admin. Host-supplied; a missing
   * callback — or one that throws — is treated as "not admin" (403), so a buggy
   * host predicate fails closed rather than leaking the query API.
   */
  isAdmin?: (c: Context) => boolean;
}

/**
 * Build the admin-gate middleware (REQUIREMENTS.md §5.1). Calls `isAdmin(c)`
 * inside a try/catch (§1.3 failure isolation, mirroring ingest.ts's getUserId
 * guard): any throw is swallowed and treated as non-admin. On non-admin it
 * returns the §5.5 403 and does NOT call next(); on admin it proceeds.
 */
export function adminGate(opts: AdminGateOptions): MiddlewareHandler {
  return async (c, next) => {
    let admin = false;
    try {
      admin = opts.isAdmin?.(c) ?? false;
    } catch (err) {
      console.warn(`[beacon] adminGate: isAdmin failed: ${String(err)}`);
    }

    if (!admin) {
      return errorResponse(c, 'UNAUTHORIZED', 'admin access required');
    }
    await next();
  };
}

/**
 * Constant-time check that a request carries the configured trusted-ingest bearer
 * token (the M2 security cornerstone — see BeaconConfig.trustedIngestToken).
 * `authorization` is the raw Authorization header value; its `Bearer <token>`
 * payload is compared to `expected` — both SHA-256'd to fixed 32-byte digests so
 * timingSafeEqual never throws on a length mismatch and the comparison leaks
 * neither token length nor content via timing (mirrors makeIsAdmin in apps/server).
 *
 * Fail-closed: returns false when no trusted token is configured (trusted ingest
 * disabled), when the header is absent, or when it is not a Bearer credential. The
 * token value is never logged.
 */
export function verifyTrustedBearer(
  authorization: string | null | undefined,
  expected: string | undefined,
): boolean {
  if (!expected) return false; // trusted ingest disabled → fail closed
  const provided = (authorization ?? '').match(/^Bearer\s+(.+)$/i)?.[1];
  if (provided === undefined) return false; // absent / non-Bearer credential
  const expectedDigest = createHash('sha256').update(expected).digest();
  const providedDigest = createHash('sha256').update(provided).digest();
  return timingSafeEqual(expectedDigest, providedDigest);
}
