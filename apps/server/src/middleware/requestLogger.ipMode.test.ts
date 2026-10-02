import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { BeaconEvent } from '@pi-innovations/beacon-sdk';
import { Hono } from 'hono';
import { createIpPolicy } from '../visitors/ipSalt';
import { VisitorTokenStore } from '../visitors/tokenStore';
import { requestLogger } from './requestLogger';

for (const hashIPs of [undefined, true, false]) {
  test(`ipMode default compatibility token seed ${hashIPs}`, async () => {
    const store = new VisitorTokenStore();
    const policy = createIpPolicy({ hashIPs });
    const events: BeaconEvent[] = [];
    const app = new Hono();
    app.use(
      requestLogger(
        { push: (event) => events.push(event) },
        { productId: 'test', tokenStore: store, ipPolicy: policy },
      ),
    );
    app.get('/', (c) => c.text(c.get('beaconVisitorToken') ?? ''));
    try {
      const res = await app.request('/', { headers: { 'x-forwarded-for': '198.51.100.9' } });
      const token = await res.text();
      const expected =
        hashIPs === false
          ? '198.51.100.9'
          : createHash('sha256').update('198.51.100.9').digest('hex');
      expect(store.get(token)?.ipHash).toBe(expected);
      expect(events[0]?.context?.ip).toBe(expected);
    } finally {
      store.stop();
      policy.stop();
    }
  });
}
test('ipMode none token seeds constant across distinct clients', async () => {
  const store = new VisitorTokenStore();
  const policy = createIpPolicy({ ipMode: 'none' });
  const events: BeaconEvent[] = [];
  const app = new Hono();
  app.use(
    requestLogger(
      { push: (event) => events.push(event) },
      { productId: 'test', tokenStore: store, ipPolicy: policy },
    ),
  );
  app.get('/', (c) => c.text(c.get('beaconVisitorToken') ?? ''));
  try {
    for (const ip of ['198.51.100.9', '203.0.113.7']) {
      const token = await (await app.request('/', { headers: { 'x-forwarded-for': ip } })).text();
      expect(store.get(token)?.ipHash).toBe('');
    }
    expect(events).toHaveLength(2);
    for (const event of events) expect(event.context?.ip).toBeUndefined();
  } finally {
    store.stop();
    policy.stop();
  }
});
