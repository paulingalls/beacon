import { describe, expect, test } from 'bun:test';

// Import BY PACKAGE NAME (not relative) so this exercises the package.json exports map and
// workspace resolution exactly as an external consumer would.
import {
  APP_CONTEXT_HEADER,
  type AppContext,
  BeaconClient,
  type BeaconClientConfig,
  buildAppContextHeader,
} from '@pi-innovations/beacon-client';
import { getDeviceContext, useBeaconLifecycle } from '@pi-innovations/beacon-client/react-native';
import { useBeaconWeb } from '@pi-innovations/beacon-client/web';

import manifest from './../package.json';

describe('@pi-innovations/beacon-client root export', () => {
  test('resolves BeaconClient and the appContext helpers by package name', () => {
    expect(typeof BeaconClient).toBe('function');
    expect(typeof buildAppContextHeader).toBe('function');
    expect(APP_CONTEXT_HEADER).toBe('X-App-Context');
  });
});

describe('subpath exports', () => {
  test('./react-native resolves the lifecycle wrapper + device context', () => {
    expect(typeof useBeaconLifecycle).toBe('function');
    expect(typeof getDeviceContext).toBe('function');
  });

  test('./web resolves the web wrapper', () => {
    expect(typeof useBeaconWeb).toBe('function');
  });
});

describe('package as a dependency', () => {
  test('E2E: a consumer constructs BeaconClient via the package name and tracks an event', () => {
    const cfg: BeaconClientConfig = {
      endpoint: 'https://ingest.test/events',
      productId: 'clipcast',
      appContext: { appVersion: '1.0.0', platform: 'web' },
    };
    const client = new BeaconClient(cfg);
    expect(() => client.track('app_open')).not.toThrow();
    client.shutdown(); // cancel the real flush timer so the test doesn't leak it
  });

  test('the exported types are usable in consumer code', () => {
    const ctx: AppContext = { appVersion: '2.0.0', platform: 'ios', os: 'iOS 17' };
    expect(buildAppContextHeader(ctx)[APP_CONTEXT_HEADER]).toContain('"appVersion":"2.0.0"');
  });
});

describe('manifest', () => {
  test('is dependency-free: no runtime deps and no react/react-native peer deps', () => {
    // The platform wrappers inject react/react-native (they import neither), so the package
    // declares no dependencies of any kind. Declaring react as a peer dep would also wrongly
    // trip biome's React rules-of-hooks on the injection-based use* functions.
    const m = manifest as { dependencies?: unknown; peerDependencies?: unknown };
    expect(m.dependencies).toBeUndefined();
    expect(m.peerDependencies).toBeUndefined();
  });

  test('maps the documented export subpaths', () => {
    const m = manifest as { exports?: Record<string, string> };
    expect(m.exports?.['.']).toBe('./src/index.ts');
    expect(m.exports?.['./react-native']).toBe('./src/platform/reactNative.ts');
    expect(m.exports?.['./web']).toBe('./src/platform/web.ts');
  });
});
