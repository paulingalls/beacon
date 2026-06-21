import { describe, expect, test } from 'bun:test';
import { createHttpBeacon, verifyTrustedBearer } from './index';

// The createBeacon (DB-backed) coverage moved to apps/server/src/createBeacon.test.ts
// with the factory itself (Milestone 4). This file guards only the postgres-free
// emit-SDK export surface.

describe('public API exports', () => {
  test('re-exports verifyTrustedBearer for host reuse', () => {
    expect(typeof verifyTrustedBearer).toBe('function');
    expect(verifyTrustedBearer('Bearer s3cret', 's3cret')).toBe(true);
    expect(verifyTrustedBearer('Bearer wrong', 's3cret')).toBe(false);
    expect(verifyTrustedBearer('Bearer s3cret', undefined)).toBe(false); // fail-closed
  });

  test('re-exports createHttpBeacon (framework-agnostic factory, Milestone 3)', async () => {
    expect(typeof createHttpBeacon).toBe('function');
    // Smoke: constructs without a DB (HTTP single-writer — no postgres) and exposes
    // the capture/track/flush/shutdown surface.
    const b = createHttpBeacon({
      productId: 'p',
      endpoint: 'https://beacon.example/analytics/events',
      trustedIngestToken: 't',
      fetch: (async () => new Response(null, { status: 202 })) as unknown as typeof fetch,
    });
    expect(typeof b.capture).toBe('function');
    expect(typeof b.track).toBe('function');
    expect(typeof b.flush).toBe('function');
    expect(typeof b.shutdown).toBe('function');
    await b.shutdown(); // clear the flush timer
  });
});
