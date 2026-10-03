import { describe, expect, test } from 'bun:test';
import { formatWithOptions, inspect } from 'node:util';
import { createIpPolicy } from '../../apps/server/src/visitors/ipSalt';
import { registerDbCoverageGuard, TEST_DB } from '../../apps/server/test/dbGuard';
import { createHttpBeacon } from '../../packages/beacon/src/httpBeacon';
import { digest, fixture, IP, OTHER_IP, SALTS, SECRET, sha } from './ipMode.fixture';

const snapshotLog = (args: unknown[]) =>
  formatWithOptions({ depth: null, maxArrayLength: null, maxStringLength: null }, ...args);
function expectSaltAbsent(artifact: string) {
  for (const salt of SALTS) {
    const bytes = Buffer.from(salt);
    for (const representation of [
      salt,
      bytes.toString('hex'),
      bytes.toString('base64'),
      inspect(bytes),
    ]) {
      expect(artifact).not.toContain(representation);
    }
  }
}

test('ipMode salt guard rejects structured console Buffers at creation and rotation after zeroing', () => {
  let time = Date.parse('2026-10-02T23:59:59.999Z');
  let index = 0;
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args) => {
    lines.push(snapshotLog(args));
  };
  let policy: ReturnType<typeof createIpPolicy> | undefined;
  const buffers: Buffer[] = [];
  try {
    policy = createIpPolicy(
      { ipMode: 'daily-salt' },
      {
        now: () => time,
        schedule: () => () => {},
        salt: () => {
          const salt = Buffer.from(SALTS[index++] as string);
          buffers.push(salt);
          console.log({ salt });
          return salt;
        },
      },
    );
    time += 1;
    policy.storage(IP);
    policy.stop();
    expect(lines).toHaveLength(2);
    for (const buffer of buffers) expect(buffer).toEqual(Buffer.alloc(buffer.length));
    for (const line of lines) expect(() => expectSaltAbsent(line)).toThrow();
  } finally {
    policy?.stop();
    console.log = original;
  }
});

registerDbCoverageGuard();
describe.skipIf(!TEST_DB)('ipMode live Postgres and socket', () => {
  for (const hashIPs of [undefined, true, false]) {
    test(`ipMode default compatibility hashIPs=${hashIPs}`, async () => {
      const f = await fixture({ hashIPs });
      try {
        await f.walk();
        const rows = await f.rows();
        expect(rows).toHaveLength(5);
        for (const row of rows) expect(row.context.ip).toBe(hashIPs === false ? IP : sha(IP));
      } finally {
        await f.close();
      }
    });
  }
  test('ipMode default compatibility SDK double hash', async () => {
    const f = await fixture();
    const sdk = createHttpBeacon({
      productId: 'ip-mode',
      endpoint: `${f.base}/analytics/events`,
      trustedIngestToken: SECRET,
      flushInterval: 60000,
    });
    try {
      const req = new Request('http://product/page', { headers: { 'x-forwarded-for': IP } });
      sdk.capture(req);
      sdk.track(req, 'sdk_track');
      await sdk.flush();
      const rows = await f.rows();
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.context.ip).toBe(sha(sha(IP)));
        expect(row.context.ip).not.toBe(sha(IP));
      }
    } finally {
      await sdk.shutdown();
      await f.close();
    }
  });
  test('ipMode midnight unlink all writers', async () => {
    const f = await fixture({ ipMode: 'daily-salt' });
    try {
      await f.walk();
      const before = await f.rows();
      expect(before).toHaveLength(5);
      for (const row of before) expect(row.context.ip).toBe(digest(SALTS[0] as string));
      f.midnight();
      await f.walk();
      const after = (await f.rows()).slice(5);
      expect(after).toHaveLength(5);
      for (const row of after) {
        expect(row.context.ip).toBe(digest(SALTS[1] as string));
        expect(row.context.ip).not.toBe(before[0]?.context.ip);
        expect(row.context.ip).not.toBe(sha(IP));
      }
    } finally {
      await f.close();
    }
  });
  test('ipMode salt memory only', async () => {
    const lines: string[] = [];
    const originals = [console.log, console.warn, console.error];
    console.log =
      console.warn =
      console.error =
        (...args) => {
          lines.push(snapshotLog(args));
        };
    try {
      const f = await fixture({ ipMode: 'daily-salt' });
      try {
        await f.walk();
        f.midnight();
        await f.walk();
        await f.beacon.flush();
        const response = await f.request('/analytics/schema', {
          headers: { authorization: `Bearer ${SECRET}` },
        });
        expect(response.status).toBe(200);
        const schema = await response.text();
        expect(schema).toContain('ip-mode');
        const events = await f.sql`SELECT row_to_json(e) FROM beacon_events e`;
        const meta = await f.sql`SELECT row_to_json(m) FROM beacon_meta m`;
        expect(events).toHaveLength(10);
        expect(meta.length).toBeGreaterThan(0);
        await f.close();
        for (const artifact of [JSON.stringify(events), JSON.stringify(meta), ...lines, schema]) {
          expectSaltAbsent(artifact);
        }
      } catch (error) {
        await f.close();
        throw error;
      }
    } finally {
      [console.log, console.warn, console.error] = originals as typeof originals;
    }
  });
  test('ipMode none isolation storage and ingest', async () => {
    const f = await fixture({ ipMode: 'none' });
    try {
      await f.walk();
      expect(
        (
          await f.post(
            [
              { event_type: 'trusted_bad', context: { ip: 42 } },
              { event_type: 'trusted_fallback', context: [] },
              { event_type: 'trusted_absent', context: {} },
            ],
            true,
          )
        ).status,
      ).toBe(202);
      const rows = await f.rows();
      expect(rows).toHaveLength(8);
      for (const row of rows) expect(row.context).not.toHaveProperty('ip');
      for (let i = 0; i < 7; i++) expect((await f.post([])).status).toBe(202);
      const limited = await f.post([]);
      expect(limited.status).toBe(429);
      expect(limited.headers.get('retry-after')).toBeTruthy();
      expect((await f.post([], false, OTHER_IP)).status, 'ingest B isolation').toBe(202);
    } finally {
      await f.close();
    }
  });
  test('ipMode none isolation query', async () => {
    const f = await fixture({ ipMode: 'none' });
    try {
      const init = { headers: { authorization: `Bearer ${SECRET}` } };
      expect((await f.request('/analytics/schema', init)).status).toBe(200);
      expect((await f.request('/analytics/schema', init)).status).toBe(200);
      expect((await f.request('/analytics/schema', init)).status).toBe(429);
      expect(
        (await f.request('/analytics/schema', init, OTHER_IP)).status,
        'query B isolation',
      ).toBe(200);
    } finally {
      await f.close();
    }
  });
  test('ipMode none isolation shortener create', async () => {
    const f = await fixture({ ipMode: 'none' });
    try {
      const init = {
        method: 'POST',
        headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
        body: JSON.stringify({ destination: 'https://example.com', product_id: 'ip-mode' }),
      };
      expect((await f.request('/short', init)).status).toBe(201);
      expect((await f.request('/short', init)).status).toBe(201);
      expect((await f.request('/short', init)).status).toBe(429);
      expect(
        (await f.request('/short', init, OTHER_IP)).status,
        'shortener-create B isolation',
      ).toBe(201);
    } finally {
      await f.close();
    }
  });
  test('ipMode SDK raw forwarding', async () => {
    const f = await fixture({ ipMode: 'daily-salt' });
    const sdk = createHttpBeacon({
      productId: 'ip-mode',
      endpoint: `${f.base}/analytics/events`,
      trustedIngestToken: SECRET,
      forwardRawIPs: true,
      flushInterval: 60000,
    });
    try {
      const req = new Request('http://product/page', {
        headers: { 'x-forwarded-for': `${IP}, 192.0.2.1` },
      });
      sdk.capture(req);
      sdk.track(new Request('http://product/track'), 'sdk_track', {}, { clientAddress: IP });
      await sdk.flush();
      const rows = await f.rows();
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.context.ip).toBe(digest(SALTS[0] as string));
        expect(row.context.ip).not.toBe(digest(SALTS[0] as string, sha(IP)));
      }
    } finally {
      await sdk.shutdown();
      await f.close();
    }
  });
});
