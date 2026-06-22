import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';

import { registerDbCoverageGuard, TEST_DB } from '../../test/dbGuard';
import { stubSql, withTestDb } from '../../test/helpers';
import { createBeacon } from '../createBeacon';
import { EventBuffer } from '../events/buffer';
import { VisitorTokenStore } from '../visitors/tokenStore';
import { createIdentifyHandler } from './identify';

registerDbCoverageGuard();

const TRUSTED = 'trusted-secret';

// Build a Hono app mounting the identify handler, plus a begin() call counter so a
// test can prove the associate core was (or was not) reached without a live DB.
function makeApp(trustedIngestToken: string | undefined) {
  let beginCalls = 0;
  const sql = stubSql({
    begin: async () => {
      beginCalls += 1;
    },
  });
  const store = new VisitorTokenStore();
  const buffer = new EventBuffer(sql);
  const app = new Hono();
  app.post('/identify', createIdentifyHandler({ sql, store, buffer, trustedIngestToken }));
  return { app, store, beginCalls: () => beginCalls };
}

function post(app: Hono, headers: Record<string, string>, body: string) {
  return app.request('/identify', { method: 'POST', headers, body });
}

const json = { 'content-type': 'application/json' };
const trustedHeaders = { ...json, authorization: `Bearer ${TRUSTED}` };

describe('identify trust gate', () => {
  test('rejects an absent bearer with 403 and never reaches the associate core', async () => {
    const { app, store, beginCalls } = makeApp(TRUSTED);
    const res = await post(app, json, JSON.stringify({ visitor_token: 'v1', user_id: 'u1' }));
    expect(res.status).toBe(403);
    expect(beginCalls()).toBe(0);
    store.stop();
  });

  test('rejects an invalid bearer with 403', async () => {
    const { app, store, beginCalls } = makeApp(TRUSTED);
    const res = await post(
      app,
      { ...json, authorization: 'Bearer wrong' },
      JSON.stringify({ visitor_token: 'v1', user_id: 'u1' }),
    );
    expect(res.status).toBe(403);
    expect(beginCalls()).toBe(0);
    store.stop();
  });

  test('fails closed (403) when trusted ingest is disabled, even with a bearer', async () => {
    const { app, store } = makeApp(undefined);
    const res = await post(
      app,
      trustedHeaders,
      JSON.stringify({ visitor_token: 'v1', user_id: 'u1' }),
    );
    expect(res.status).toBe(403);
    store.stop();
  });
});

describe('identify body validation (trusted)', () => {
  test('400 when visitor_token is missing', async () => {
    const { app, store, beginCalls } = makeApp(TRUSTED);
    const res = await post(app, trustedHeaders, JSON.stringify({ user_id: 'u1' }));
    expect(res.status).toBe(400);
    expect(beginCalls()).toBe(0);
    store.stop();
  });

  test('400 when user_id is missing', async () => {
    const { app, store } = makeApp(TRUSTED);
    const res = await post(app, trustedHeaders, JSON.stringify({ visitor_token: 'v1' }));
    expect(res.status).toBe(400);
    store.stop();
  });

  test('400 when a field is blank, oversize, or non-string', async () => {
    const { app, store } = makeApp(TRUSTED);
    const blank = await post(
      app,
      trustedHeaders,
      JSON.stringify({ visitor_token: '  ', user_id: 'u1' }),
    );
    const oversize = await post(
      app,
      trustedHeaders,
      JSON.stringify({ visitor_token: 'v1', user_id: 'u'.repeat(101) }),
    );
    const nonString = await post(
      app,
      trustedHeaders,
      JSON.stringify({ visitor_token: 42, user_id: 'u1' }),
    );
    expect(blank.status).toBe(400);
    expect(oversize.status).toBe(400);
    expect(nonString.status).toBe(400);
    store.stop();
  });

  test('400 on an unparseable JSON body', async () => {
    const { app, store } = makeApp(TRUSTED);
    const res = await post(app, trustedHeaders, 'not json');
    expect(res.status).toBe(400);
    store.stop();
  });
});

describe.skipIf(!TEST_DB)('identify endpoint (integration, live Postgres)', () => {
  const getDb = withTestDb(TEST_DB as string);

  test('a trusted caller back-fills the anonymous trail and responds 204', async () => {
    const migrator = getDb();
    const beacon = createBeacon({
      productId: 'beacon-test',
      postgres: { connectionString: TEST_DB as string },
      trustedIngestToken: TRUSTED,
    });
    const app = new Hono();
    app.use('*', beacon.middleware());
    app.get('/p', (c) => c.text(beacon.getVisitorToken(c) ?? 'none'));
    app.route(beacon.basePath, beacon.router());

    // Mint an anonymous trail with attribution, then a second hit on the token.
    const first = await app.request('/p?utm_source=newsletter');
    const token = await first.text();
    await Bun.sleep(2);
    await app.request(`/p?_t=${token}`);
    await beacon.flush();

    const res = await app.request(`${beacon.basePath}/identify`, {
      method: 'POST',
      headers: { ...json, authorization: `Bearer ${TRUSTED}` },
      body: JSON.stringify({ visitor_token: token, user_id: 'user-42' }),
    });
    expect(res.status).toBe(204);

    const rows = await migrator<{ user_id: string | null; src: string | null }[]>`
      SELECT user_id, attribution->>'utm_source' AS src
      FROM beacon_events WHERE visitor_token = ${token}
      ORDER BY timestamp ASC, received_at ASC`;
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((r) => r.user_id === 'user-42')).toBe(true); // whole trail back-filled
    expect(rows[0]?.src).toBe('newsletter'); // first-touch attribution preserved

    await beacon.shutdown();
  });
});
