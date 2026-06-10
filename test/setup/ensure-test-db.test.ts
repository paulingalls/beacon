import { describe, expect, test } from 'bun:test';

import { verifyExternalDb } from './ensure-test-db';

// verifyExternalDb is the CI preflight: when TEST_DATABASE_URL is externally
// preset (CI service container / explicit override), it probes connectivity and
// must FAIL LOUD (throw) when the DB is unreachable — never return silently,
// which would let integration suites fail one-by-one with confusing low-level
// errors. These cases need no live DB: an unreachable host (connection refused)
// and a malformed connection string both reject fast.
describe('verifyExternalDb (CI connectivity preflight)', () => {
  test('throws a TEST_DATABASE_URL-naming error when the host is unreachable', async () => {
    // Port 1 refuses immediately — a well-formed URL whose Postgres cannot be
    // reached. The awaited probe must reject, and the message must name the var
    // so a misconfigured CI service container is obvious at a glance.
    const url = 'postgres://beacon:beacon@127.0.0.1:1/beacon';
    await expect(verifyExternalDb(url)).rejects.toThrow(/TEST_DATABASE_URL/);
  });

  test('rejects (fails loud) on a malformed connection string', async () => {
    // postgres.js throws synchronously at construction on an out-of-range port
    // (mirrors db.test.ts port-99999). The preflight must surface that as a
    // rejection, not swallow it — construction happens inside the probe's guard.
    const url = 'postgres://u:p@127.0.0.1:99999/db';
    await expect(verifyExternalDb(url)).rejects.toThrow();
  });
});
