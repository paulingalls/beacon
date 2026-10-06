import { createHash } from 'node:crypto';
import type { Handler } from 'hono';
import type { Sql } from 'postgres';
import type { EventBuffer } from '../events/buffer';
import { errorResponse } from './errors';

export function createErasureHandler(sql: Sql, buffer: EventBuffer): Handler {
  return async (c) => {
    const userId = c.req.param('userId');
    try {
      if (userId === undefined) throw new Error('missing erasure route parameter');
      await buffer.purgeUser(userId);
      const count = await sql.begin(async (tx) => {
        await tx`LOCK TABLE beacon_events IN SHARE ROW EXCLUSIVE MODE`;
        const deleted = await tx`DELETE FROM beacon_events WHERE user_id = ${userId}`;
        const count = deleted.count;
        const hash = createHash('sha256').update(userId).digest('hex');
        await tx`INSERT INTO beacon_erasures (user_id_hash, count) VALUES (${hash}, ${count})`;
        return count;
      });
      return c.json({ count });
    } catch {
      return errorResponse(c, 'INTERNAL_ERROR', 'event erasure failed');
    }
  };
}
