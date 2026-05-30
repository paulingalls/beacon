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
