import { describe, expect, test } from 'bun:test';

// DB-free smoke for the SDK acceptance surface: proves the assembled package resolves BY NAME
// (root + the exports map) and constructs/operates without a server or Postgres. The live
// end-to-end proof lives in sdk.acceptance.test.ts (gated on TEST_DATABASE_URL); this smoke
// always runs so the surface has coverage even when docker Postgres is unavailable.
import { BeaconClient } from '@pi-innovations/beacon-client';

describe('sdk smoke — package resolves and constructs by name', () => {
  test('constructs a BeaconClient, queues an event, and tears down', () => {
    const client = new BeaconClient({
      endpoint: 'https://ingest.example/analytics/events',
      productId: 'sdk-smoke',
      appContext: { appVersion: '1.0.0', platform: 'web' },
      flushInterval: 60_000,
    });
    expect(() => client.track('app_open')).not.toThrow();
    expect(client.getContextHeaders()['X-App-Context']).toContain('"platform":"web"');
    client.shutdown(); // cancel the flush timer so the test doesn't leak it
  });
});
