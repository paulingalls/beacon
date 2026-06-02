import { describe, expect, test } from 'bun:test';

import { generateCode } from './codeGen';

describe('generateCode', () => {
  test('returns exactly 6 characters', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateCode()).toHaveLength(6);
    }
  });

  test('returns only [a-zA-Z0-9] characters', () => {
    const allowed = /^[a-zA-Z0-9]{6}$/;
    for (let i = 0; i < 1000; i++) {
      // 1000 samples (6000 chars) makes it very likely any out-of-alphabet
      // byte produced by a biased/buggy mapping would surface here.
      expect(generateCode()).toMatch(allowed);
    }
  });

  test('produces varied codes across 100 calls (not all identical)', () => {
    const codes = new Set<string>();
    for (let i = 0; i < 100; i++) {
      codes.add(generateCode());
    }
    // Over a 56.8-billion space, 100 random draws are effectively always
    // distinct; assert at minimum they are not collapsed to a single value
    // (which would betray a broken, non-random generator).
    expect(codes.size).toBeGreaterThan(1);
  });
});
