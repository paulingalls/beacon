import { describe, expect, test } from 'bun:test';

// The relay public surface (execution_plan.json §Milestone 7, story-003). Proves the
// trusted relay interface is reachable BY PACKAGE NAME from both the package root and the
// ./relay subpath — the way a real consumer imports it — not just by relative path. Self-
// resolution works via the workspace node_modules symlink + the package.json exports map.
import * as relayRoot from '@pi-innovations/beacon-sdk';
import * as relaySubpath from '@pi-innovations/beacon-sdk/relay';

const RELAY_FUNCTIONS = [
  'createIngestRelay',
  'relayBatch',
  'createIdentifyRelay',
  'relayIdentify',
] as const;

describe('relay public surface', () => {
  test('the root package exports every relay function', () => {
    for (const name of RELAY_FUNCTIONS) {
      expect(typeof (relayRoot as Record<string, unknown>)[name]).toBe('function');
    }
  });

  test('the ./relay subpath exports every relay function', () => {
    for (const name of RELAY_FUNCTIONS) {
      expect(typeof (relaySubpath as Record<string, unknown>)[name]).toBe('function');
    }
  });

  test('root and subpath resolve to the same relay implementations', () => {
    const root = relayRoot as Record<string, unknown>;
    const sub = relaySubpath as Record<string, unknown>;
    for (const name of RELAY_FUNCTIONS) {
      expect(sub[name]).toBe(root[name]);
    }
  });

  test('internal forward helpers are NOT part of the public surface', () => {
    const sub = relaySubpath as Record<string, unknown>;
    for (const internal of ['forwardJson', 'classify', 'resultToResponse']) {
      expect(sub[internal]).toBeUndefined();
    }
  });
});
