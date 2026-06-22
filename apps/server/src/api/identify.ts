import type { Handler } from 'hono';
import type { Sql } from 'postgres';
import type { EventBuffer } from '../events/buffer';
import { associateVisitor } from '../visitors/associate';
import type { VisitorTokenStore } from '../visitors/tokenStore';
import { verifyTrustedBearer } from './auth';
import { errorResponse } from './errors';

// Trusted HTTP identify endpoint (REQUIREMENTS.md §2.4 / Milestone 5). The SPA's
// server relays a login here — POST {basePath}/identify {visitor_token, user_id} —
// and Beacon back-fills the anonymous trail to the real user. A cross-origin
// browser can't carry the host's session cookie to Beacon, so identify is
// server-relayed and gated by the SAME M2 trusted bearer that gates ingest: only a
// verified caller may assert a user_id. The back-fill itself is the shared
// associate core (visitors/associate.ts), best-effort and idempotent.

const MAX_ID_LENGTH = 100;

export interface IdentifyOptions {
  /** Postgres client (the back-fill transaction runs here). */
  sql: Sql;
  /** Visitor token store — supplies first-touch attribution for the trail. */
  store: VisitorTokenStore;
  /** Event buffer, drained by the associate core so the trail is on disk first. */
  buffer: EventBuffer;
  /**
   * Shared secret authorizing the trusted caller (same field that gates ingest).
   * When unset, identify is disabled (fail-closed): every call is rejected 403.
   * Compared in constant time via verifyTrustedBearer; never logged.
   */
  trustedIngestToken?: string;
}

/** Non-empty trimmed string ≤ MAX_ID_LENGTH, else null (mirrors ingest's rule). */
function validShortString(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value === '' || value.length > MAX_ID_LENGTH) return null;
  return value;
}

/**
 * Build the `POST {basePath}/identify` handler. Trust-gates first (fail-closed
 * 403), then validates the body, then runs the shared associate core. Returns 204
 * on success — the back-fill is best-effort (never throws) and returns nothing;
 * callers verify via the query API, not the response body.
 */
export function createIdentifyHandler(opts: IdentifyOptions): Handler {
  return async (c) => {
    // Trusted-caller gate (M2). Untrusted/absent/misconfigured → 403, and nothing
    // below (body parse, DB) runs — the anonymous public path never reaches here.
    if (!verifyTrustedBearer(c.req.header('authorization'), opts.trustedIngestToken)) {
      return errorResponse(c, 'UNAUTHORIZED', 'trusted bearer required');
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 'INVALID_PARAMETER', 'request body must be valid JSON');
    }
    const { visitor_token, user_id } = (body ?? {}) as Record<string, unknown>;

    if (visitor_token === undefined || visitor_token === null) {
      return errorResponse(c, 'MISSING_PARAMETER', 'visitor_token is required', 'visitor_token');
    }
    if (user_id === undefined || user_id === null) {
      return errorResponse(c, 'MISSING_PARAMETER', 'user_id is required', 'user_id');
    }
    const token = validShortString(visitor_token);
    if (token === null) {
      return errorResponse(
        c,
        'INVALID_PARAMETER',
        'visitor_token must be a string ≤100 chars',
        'visitor_token',
      );
    }
    const userId = validShortString(user_id);
    if (userId === null) {
      return errorResponse(
        c,
        'INVALID_PARAMETER',
        'user_id must be a string ≤100 chars',
        'user_id',
      );
    }

    // Best-effort back-fill (never throws); a swallowed DB error still returns 204,
    // consistent with the fire-and-forget contract — callers confirm via the query API.
    await associateVisitor(opts.buffer, opts.sql, opts.store, token, userId);
    return c.body(null, 204);
  };
}
