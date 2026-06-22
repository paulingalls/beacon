// Shared visitor-association core (REQUIREMENTS.md §2.4). Extracted from
// createBeacon.ts (Milestone 5) so the in-process Beacon.associateVisitor helper
// and the HTTP POST {basePath}/identify endpoint share ONE implementation: drain
// the buffered trail, back-fill user_id on the anonymous events, copy first-touch
// attribution onto the earliest event, drop the token. Best-effort — never throws
// (§1.3), so a Postgres outage during login can't crash the host.

import type { Sql } from 'postgres';
import type { EventBuffer } from '../events/buffer';
import type { VisitorTokenStore } from './tokenStore';

/** Max flush passes when draining before association — bounds login latency. */
const MAX_DRAIN_PASSES = 10;

/**
 * Flush the buffer to (near-)empty before association so the visitor trail is on
 * disk. flush() drains one batch; loop for a multi-batch backlog, capped, and
 * stop early when a pass makes no progress (writes failing/backpressured).
 */
async function drainBuffer(buffer: EventBuffer): Promise<void> {
  let remaining = buffer.stats().buffered;
  for (let pass = 0; pass < MAX_DRAIN_PASSES && remaining > 0; pass++) {
    await buffer.flush();
    const next = buffer.stats().buffered;
    if (next >= remaining) break; // no progress — don't spin
    remaining = next;
  }
}

/**
 * Associate an anonymous trail with a user (§2.4). Persist any buffered trail
 * first: a login within the flush window would otherwise miss still-buffered
 * events (and store.remove would drop their first-touch attribution permanently).
 *
 * The two UPDATEs run in one transaction for all-or-nothing semantics: the
 * `user_id IS NULL` guard keeps the back-fill idempotent (re-runs never clobber an
 * already-associated event), and attribution lands on the earliest event only when
 * the token record carries it — so a partial failure can't leave the trail
 * associated yet attribution lost. The token is removed only after the commit; on
 * any failure it is retained so a retry can re-run cleanly. Wrapped so a Postgres
 * outage during login can never crash the host (§1.3). Only persisted events are
 * updated — the drain above puts the trail on disk first.
 */
export async function associateVisitor(
  buffer: EventBuffer,
  sql: Sql,
  store: VisitorTokenStore,
  token: string | null,
  userId: string,
): Promise<void> {
  await drainBuffer(buffer);
  if (!token) return; // direct login, no anonymous trail
  try {
    await sql.begin(async (tx) => {
      await tx`
        UPDATE beacon_events SET user_id = ${userId}
        WHERE visitor_token = ${token} AND user_id IS NULL`;

      const record = store.get(token);
      if (record?.attribution) {
        await tx`
          UPDATE beacon_events SET attribution = ${tx.json(record.attribution)}
          WHERE event_id = (
            SELECT event_id FROM beacon_events
            WHERE visitor_token = ${token}
            ORDER BY timestamp ASC, received_at ASC
            LIMIT 1
          )`;
      }
    });
    store.remove(token);
  } catch (err) {
    console.warn(`[beacon] associateVisitor failed: ${String(err)}`);
  }
}
