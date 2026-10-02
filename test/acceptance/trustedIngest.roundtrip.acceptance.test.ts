import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createHttpBeacon } from '@pi-innovations/beacon-sdk';
import { Hono } from 'hono';
import { createBeacon } from '../../apps/server/src/createBeacon';
// Live-DB setup via the package's own internals by relative path, as the sibling acceptance suites do.
import { closeDb, createDb } from '../../apps/server/src/storage/db';
import { runMigrations } from '../../apps/server/src/storage/migrate';
import { registerDbCoverageGuard, TEST_DB } from '../../apps/server/test/dbGuard';

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
  for (const configured of [false, true]) {
    test(`normalization SDK capture and public/trusted batch, configured=${configured}`, async () => {
      const product = `normalize-ingest-${configured}`;
      const raw = '/p/abc/story/xyz';
      const pattern = '/p/[legacyId]/story/[storyId]';
      const instance = createBeacon({
        productId: product,
        postgres: { connectionString: TEST_DB as string },
        isAdmin: () => true,
        trustedIngestToken: SECRET,
        flushInterval: 60_000,
        normalizePath: configured
          ? (p) => {
              if (p === '/drop') return null;
              if (p === '/throw') throw new Error('/throw-secret');
              return p === raw ? pattern : p;
            }
          : undefined,
      });
      const app = new Hono();
      app.route(instance.basePath, instance.router());
      const socket = Bun.serve({ port: 0, fetch: app.fetch });
      const url = `http://localhost:${socket.port}${instance.basePath}/events`;
      const sdk = createHttpBeacon({
        productId: product,
        endpoint: url,
        trustedIngestToken: SECRET,
        flushInterval: 60_000,
      });
      const post = (events: unknown[], trusted = false) =>
        fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(trusted ? { authorization: `Bearer ${SECRET}` } : {}),
          },
          body: JSON.stringify({ events }),
        });
      try {
        sdk.capture(new Request(`https://product.example${raw}`), { status: 201 });
        await sdk.flush();
        for (const trusted of [false, true]) {
          const res = await post(
            [
              { event_type: 'page_view', properties: { path: raw } },
              { event_type: 'screen_view', properties: { screen: raw } },
              {
                event_type: 'literal',
                properties: { path: ' /P/abc%20/story/xyz?token#hash ', screen: raw },
              },
            ],
            trusted,
          );
          expect(res.status).toBe(202);
          expect((await res.json()).accepted).toBe(3);
        }
        await instance.flush();
        const stored = await sql<{ event_type: string; properties: Record<string, unknown> }[]>`
          SELECT event_type, properties FROM beacon_events WHERE product_id = ${product}`;
        expect(stored).toHaveLength(7);
        expect(
          stored.filter((e) => e.event_type === 'request').map((e) => e.properties.path),
        ).toEqual([configured ? pattern : raw]);
        expect(
          stored.filter((e) => e.event_type === 'page_view').map((e) => e.properties.path),
        ).toEqual([configured ? pattern : raw, configured ? pattern : raw]);
        expect(
          stored.filter((e) => e.event_type === 'screen_view').map((e) => e.properties.screen),
        ).toEqual([configured ? pattern : raw, configured ? pattern : raw]);
        expect(stored.filter((e) => e.event_type === 'literal').map((e) => e.properties)).toEqual([
          { path: ' /P/abc%20/story/xyz?token#hash ', screen: raw },
          { path: ' /P/abc%20/story/xyz?token#hash ', screen: raw },
        ]);
        const queried = await fetch(
          `http://localhost:${socket.port}${instance.basePath}/events?${WINDOW}&product_id=${product}`,
        );
        const body = (await queried.json()) as {
          events: Array<{ event_type: string; properties: Record<string, unknown> }>;
        };
        expect(queried.status).toBe(200);
        expect(body.events).toHaveLength(7);
        expect(
          body.events.filter((e) => e.event_type === 'request').map((e) => e.properties.path),
        ).toEqual([configured ? pattern : raw]);
        if (configured) {
          const mixed = await post([
            { event_type: 'kept', properties: { path: raw } },
            { event_type: 'dropped', properties: { path: '/drop' } },
            { event_type: 'kept_empty', properties: { path: '' } },
          ]);
          expect((await mixed.json()).accepted).toBe(2);
          const failed = await post([
            { event_type: 'must_rollback', properties: { path: '/safe' } },
            { event_type: 'must_rollback', properties: { screen: '/throw' } },
            { event_type: 'screen_view', properties: { screen: '/throw' } },
          ]);
          expect(failed.status).toBe(500);
          await instance.flush();
          const rows = await sql<{ event_type: string; properties: Record<string, unknown> }[]>`
            SELECT event_type, properties FROM beacon_events WHERE product_id = ${product}`;
          expect(rows).toHaveLength(9);
          expect(
            rows.filter((e) => e.event_type === 'must_rollback' || e.event_type === 'dropped'),
          ).toEqual([]);
          expect(rows.find((e) => e.event_type === 'kept')?.properties.path).toBe(pattern);
          expect(rows.find((e) => e.event_type === 'kept_empty')?.properties.path).toBe('');
        }
      } finally {
        await sdk.shutdown();
        socket.stop(true);
        await instance.shutdown();
      }
    }, 15_000);
  }
  for (const mode of [undefined, 'raw', 'origin', 'origin-and-path'] as const) {
    for (const input of ['https://site.example/a?token=x#f', 'not a URL']) {
      for (const writer of ['relay', 'sdk']) {
        test(`referrerMode ${mode} ${writer} ${input}`, async () => {
          const product = `referrer-${mode}-${writer}-${input.length}`;
          const instance = createBeacon({
            productId: product,
            postgres: { connectionString: TEST_DB as string },
            referrerMode: mode,
            trustedIngestToken: SECRET,
            isAdmin: () => true,
            flushInterval: 60_000,
          });
          const app = new Hono();
          app.route(instance.basePath, instance.router());
          const socket = Bun.serve({ port: 0, fetch: app.fetch });
          const url = `http://localhost:${socket.port}${instance.basePath}/events`;
          const sdk = createHttpBeacon({
            productId: product,
            endpoint: url,
            trustedIngestToken: SECRET,
            flushInterval: 60_000,
          });
          try {
            if (writer === 'sdk') {
              sdk.capture(
                new Request('https://product.example/landing?utm_source=landing&gclid=click', {
                  headers: { referer: input },
                }),
                { status: 201 },
              );
              await sdk.flush();
            } else {
              const res = await fetch(url, {
                method: 'POST',
                headers: {
                  'content-type': 'application/json',
                  authorization: `Bearer ${SECRET}`,
                  referer: 'https://relay.example/private?secret=y',
                },
                body: JSON.stringify({
                  product_id: product,
                  events: [
                    {
                      event_type: 'relay_pin',
                      context: { referrer: input, extra: 1 },
                      properties: { value: 1 },
                    },
                  ],
                }),
              });
              expect(res.status).toBe(202);
            }
            await instance.flush();
            const stored = await sql<
              {
                context: Record<string, unknown>;
                attribution: unknown;
                properties: Record<string, unknown>;
              }[]
            >`SELECT context, attribution, properties FROM beacon_events WHERE product_id = ${product}`;
            expect(stored).toHaveLength(1);
            const read = await fetch(`${url}?${WINDOW}&product_id=${product}`);
            expect(read.status).toBe(200);
            const body = (await read.json()) as {
              events: Array<{
                context: Record<string, unknown>;
                attribution: unknown;
                properties: Record<string, unknown>;
              }>;
            };
            expect(body.events).toHaveLength(1);
            for (const row of [stored[0], body.events[0]]) {
              const context = row?.context as Record<string, unknown>;
              if ((mode === 'origin' || mode === 'origin-and-path') && input === 'not a URL')
                expect(Object.hasOwn(context, 'referrer')).toBe(false);
              else
                expect(context.referrer).toBe(
                  mode === 'origin'
                    ? 'https://site.example'
                    : mode === 'origin-and-path'
                      ? 'https://site.example/a'
                      : input,
                );
              if (writer === 'sdk') {
                expect(row?.attribution).toEqual({});
                expect(row?.properties).toMatchObject({
                  path: '/landing',
                  method: 'GET',
                  status: 201,
                });
              } else {
                expect(context.extra).toBe(1);
                expect(row?.properties).toEqual({ value: 1 });
              }
            }
          } finally {
            await sdk.shutdown();
            socket.stop(true);
            await instance.shutdown();
          }
        });
      }
    }
  }
});
