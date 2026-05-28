import { expect, test } from 'bun:test';

import * as beacon from './index';

test('beacon package entry imports without error', () => {
  expect(beacon).toBeDefined();
  expect(typeof beacon).toBe('object');
});
