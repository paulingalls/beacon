import { describe, expect, test } from 'bun:test';

import { isDbCoverageSatisfied } from './dbGuard';

// isDbCoverageSatisfied is the pure predicate behind the shared DB-coverage guard
// (decision a02afa9ca404): integration suites must FAIL loud when a DB is expected
// but unset, the only sanctioned skip being the explicit BEACON_TEST_DB=off opt-out.
// The registrar that calls test() can't be asserted without a live DB; this predicate
// is the testable seam, exercised DB-free across its three branches.
describe('isDbCoverageSatisfied (DB-coverage guard predicate)', () => {
  test('satisfied when a TEST_DATABASE_URL is present', () => {
    expect(isDbCoverageSatisfied({ TEST_DATABASE_URL: 'postgres://x/y' })).toBe(true);
  });

  test('satisfied when the DB is explicitly opted out (BEACON_TEST_DB=off)', () => {
    expect(isDbCoverageSatisfied({ BEACON_TEST_DB: 'off' })).toBe(true);
  });

  test('NOT satisfied when neither is set — the fail-loud case', () => {
    // A DB expected (repo root, docker up) but TEST_DATABASE_URL unset must fail the
    // guard, not skipIf-green. This is the coverage gap the guard exists to catch.
    expect(isDbCoverageSatisfied({})).toBe(false);
  });
});
