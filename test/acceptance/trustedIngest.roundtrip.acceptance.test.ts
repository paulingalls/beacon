import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import { createBeacon } from '@pi-innovations/beacon';
import { Hono } from 'hono';
// Live-DB setup via the package's own internals by relative path, as the sibling acceptance suites do.
import { closeDb, createDb } from '../../packages/beacon/src/storage/db';
import { runMigrations } from '../../packages/beacon/src/storage/migrate';
import { registerDbCoverageGuard, TEST_DB } from '../../packages/beacon/test/dbGuard';

// story-004 CAPSTONE (Milestone 2): the trusted-caller bearer boundary exercised end to end.
// A trusted server RELAY (raw HTTP POST carrying `Authorization: Bearer <secret>` — M2 has no
// client SDK surface) drives a REAL createBeacon ingest over the network, then the result is read
// back through the QUERY API (GET {basePath}/events), the agent/dashboard consumer path. stories
// 001-003 proved each layer in isolation (verify helper / ingest handler / host env wiring); this
// proves the full relay → ingest → query round-trip across the http_websocket surface. A failure
// here means the M2 trust contract regressed across a seam no single unit test covers.

const PRODUCT = 'trusted-ingest-roundtrip';
const SECRET = 'capstone-trusted-secret';
const WINDOW = 'after=2020-01-01T00:00:00Z&before=2030-01-01T00:00:00Z';
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

registerDbCoverageGuard();

interface QueriedEvent {
  event_type: string;
  user_id: string | null;
  context: { ip?: string; user_agent?: string; referrer?: string };
}

describe.skipIf(!TEST_DB)('capstone — trusted-ingest round-trip (relay → ingest → query)', () => {
  let sql: ReturnType<typeof createDb>;
  let beacon: ReturnType<typeof createBeacon>;
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;

  /** POST a batch to the ingest endpoint over the network, optionally bearer-authorized. */
  function relayPost(headers: Record<string, string>, events: unknown[]): Promise<Response> {
    return fetch(`${baseUrl}${beacon.basePath}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ events }),
    });
  }

  /** GET a query endpoint over the network (the admin/agent consumer path). */
  function query(path: string): Promise<Response> {
    return fetch(`${baseUrl}${beacon.basePath}${path}`);
  }

  beforeAll(async () => {
    sql = createDb({ connectionString: TEST_DB as string });
    await sql`DROP TABLE IF EXISTS beacon_events, beacon_short_links, beacon_meta, beacon_migrations CASCADE`;
    await runMigrations(sql);

    // trustedIngestToken enables the M2 path; isAdmin lets the query API serve reads; hashIPs on
    // so body-supplied ips are hashed at rest. No getUserId: a relay connection has no host session,
    // so identity must come per-event from the (trusted) body.
    beacon = createBeacon({
      productId: PRODUCT,
      postgres: { connectionString: TEST_DB as string },
      isAdmin: () => true,
      trustedIngestToken: SECRET,
      hashIPs: true,
      flushInterval: 60_000, // disable the server timer; the test drains via beacon.flush()
    });
    const app = new Hono();
    app.route(beacon.basePath, beacon.router()); // mounts BOTH the ingest and the query endpoints
    server = Bun.serve({ port: 0, fetch: app.fetch });
    baseUrl = `http://localhost:${server.port}`;
  }, 15_000);

  afterAll(async () => {
    server.stop(true);
    await beacon.shutdown();
    await sql`DROP TABLE IF EXISTS beacon_events, beacon_short_links, beacon_meta, beacon_migrations CASCADE`;
    await closeDb(sql);
  }, 15_000);

  test('E2E: a trusted relay batch stores per-event identity/context, read back via the query API', async () => {
    // A single relay connection carries events for TWO different end-users, each with its own
    // client context — the multi-user relay shape M2 is built for.
    const trusted = await relayPost({ authorization: `Bearer ${SECRET}` }, [
      {
        event_type: 'trusted_a',
        user_id: 'alice',
        context: { ip: '198.51.100.9', user_agent: 'alice-agent', referrer: 'https://a.example' },
      },
      {
        event_type: 'trusted_b',
        user_id: 'bob',
        context: { ip: '203.0.113.7', user_agent: 'bob-agent', referrer: 'https://b.example' },
      },
    ]);
    expect(trusted.status).toBe(202);

    // An untrusted public caller (no bearer) asserting a body user_id/context — must be ignored.
    const untrusted = await relayPost({}, [
      { event_type: 'public_c', user_id: 'spoofed', context: { ip: 'evil', user_agent: 'spoof' } },
    ]);
    expect(untrusted.status).toBe(202);

    await beacon.flush();

    const res = await query(`/events?${WINDOW}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: QueriedEvent[] };
    const byType = new Map(body.events.map((e) => [e.event_type, e]));

    // Trusted events: per-event user_id honored; context REPLACED with the body's (relay transport
    // never leaks), ip hashed at rest (hashIPs on → never the raw value).
    const a = byType.get('trusted_a');
    expect(a?.user_id).toBe('alice');
    expect(a?.context.ip).toBe(sha256('198.51.100.9'));
    expect(a?.context.ip).not.toBe('198.51.100.9');
    expect(a?.context.user_agent).toBe('alice-agent');
    expect(a?.context.referrer).toBe('https://a.example');

    const b = byType.get('trusted_b');
    expect(b?.user_id).toBe('bob');
    expect(b?.context.ip).toBe(sha256('203.0.113.7'));
    expect(b?.context.user_agent).toBe('bob-agent');

    // Untrusted event: body user_id ignored (public path unchanged), and the spoofed body context
    // was NOT honored — the stored ip is not the spoofed body value.
    const c = byType.get('public_c');
    expect(c?.user_id).toBeNull();
    expect(c?.context.ip).not.toBe('evil');
  }, 15_000);

  test('E2E: a wrong bearer is rejected across the wire — body user_id ignored (fail-closed)', async () => {
    const res = await relayPost({ authorization: 'Bearer wrong-secret' }, [
      { event_type: 'wrong_bearer', user_id: 'spoofed' },
    ]);
    expect(res.status).toBe(202); // skip-not-reject: the batch is accepted, identity just ignored

    await beacon.flush();

    const read = await query(`/events?${WINDOW}&event_type=wrong_bearer`);
    const body = (await read.json()) as { events: QueriedEvent[] };
    expect(body.events).toHaveLength(1);
    expect(body.events[0]?.user_id).toBeNull();
  }, 15_000);
});
