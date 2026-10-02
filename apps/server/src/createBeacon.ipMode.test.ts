import { expect, test } from 'bun:test';
import { TEST_DB } from '../test/dbGuard';
import { createBeacon } from './createBeacon';
import type { BeaconConfig } from './types';

const config = {
  productId: 'ip-mode',
  postgres: {
    connectionString: process.env.TEST_DATABASE_URL ?? 'postgres://localhost:5546/beacon',
  },
};
for (const ipMode of ['sha256', 'daily-salt', 'none']) {
  test(`ipMode conflict refused ${ipMode}`, async () => {
    let beacon: ReturnType<typeof createBeacon> | undefined;
    try {
      expect(() => {
        beacon = createBeacon({ ...config, ipMode, hashIPs: false } as BeaconConfig);
      }).toThrow('hashIPs');
    } finally {
      await (beacon as ReturnType<typeof createBeacon> | undefined)?.shutdown();
    }
  });
}
test('ipMode invalid runtime mode refused before resources', async () => {
  let beacon: ReturnType<typeof createBeacon> | undefined;
  try {
    expect(() => {
      beacon = createBeacon({ ...config, ipMode: 'invalid' } as unknown as BeaconConfig);
    }).toThrow('ipMode');
  } finally {
    await (beacon as ReturnType<typeof createBeacon> | undefined)?.shutdown();
  }
});

for (const ipMode of ['sha256', 'daily-salt', 'none'] as const) {
  for (const hashIPs of [undefined, true]) {
    test.skipIf(!TEST_DB)(`ipMode explicit ${ipMode} accepts hashIPs=${hashIPs}`, async () => {
      const beacon = createBeacon({ ...config, ipMode, hashIPs });
      await beacon.shutdown();
    });
  }
}
