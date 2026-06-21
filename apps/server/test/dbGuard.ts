import { expect, test } from 'bun:test';

// Shared DB-coverage guard (decision a02afa9ca404): a silent skip hides coverage gaps.
// Integration suites must FAIL loud when the DB is expected (repo root, docker up) but
// TEST_DATABASE_URL is unset, rather than skipIf-green; the only sanctioned skip is the
// explicit BEACON_TEST_DB=off opt-out (the pre-commit hook). Each integration test file
// imports TEST_DB for its `describe.skipIf(!TEST_DB)` and calls registerDbCoverageGuard()
// once at top level, replacing what was a byte-identical inline copy in ~20 files.

// Captured at module load. The bunfig preload (test/setup/ensure-test-db.ts) resolves
// TEST_DATABASE_URL before any test module evaluates, so this sees the final value —
// the same timing as the per-file `const TEST_DB` it replaces.
export const TEST_DB = process.env.TEST_DATABASE_URL;

// Pure predicate (DB-free, unit-tested): satisfied when a DB URL is present OR the DB is
// explicitly opted out. Neither set → the fail-loud case the guard exists to catch.
export function isDbCoverageSatisfied(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return Boolean(env.TEST_DATABASE_URL) || env.BEACON_TEST_DB === 'off';
}

// Registers the DB-coverage test under the CALLING test file — bun:test scopes test()
// registration to the module currently being evaluated, so invoking this at an importer's
// top level registers the guard there (the same shared-helper pattern beacon-client's
// testkit relies on). Call exactly once per integration file.
export function registerDbCoverageGuard(): void {
  test('DB coverage: TEST_DATABASE_URL is set unless the DB is explicitly opted out', () => {
    expect(isDbCoverageSatisfied()).toBe(true);
  });
}
