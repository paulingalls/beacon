import { describe, expect, test } from 'bun:test';

import { decideTestDbAction, redactUrl, verifyExternalDb } from './ensure-test-db';

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

// The branch ordering is load-bearing (AC2/AC3): a preset URL must win even over
// BEACON_TEST_DB=off so CI probes it, and off-without-preset must skip DB-free
// rather than booting docker. Asserted on the pure decider so a future reorder
// can't pass silently.
describe('decideTestDbAction (preload branch ordering)', () => {
  test('preset TEST_DATABASE_URL wins — probe — even when BEACON_TEST_DB=off', () => {
    const url = 'postgres://beacon:beacon@localhost:5544/beacon';
    expect(decideTestDbAction({ TEST_DATABASE_URL: url, BEACON_TEST_DB: 'off' })).toEqual({
      kind: 'probe',
      url,
    });
  });

  test('BEACON_TEST_DB=off without a preset URL skips (DB-free), never probes or bootstraps', () => {
    expect(decideTestDbAction({ BEACON_TEST_DB: 'off' })).toEqual({ kind: 'skip' });
  });

  test('neither set — bootstrap docker', () => {
    expect(decideTestDbAction({})).toEqual({ kind: 'bootstrap' });
  });
});

// redactUrl is the credential-scrubber for shared CI logs; a regression would leak
// a real TEST_DATABASE_URL password. Assert both the strip and the fail-safe fallback.
describe('redactUrl (credential scrubbing for CI logs)', () => {
  test('strips user:password userinfo from a well-formed URL', () => {
    const redacted = redactUrl('postgres://beacon:s3cret@localhost:5544/beacon');
    expect(redacted).not.toContain('s3cret');
    expect(redacted).not.toContain('beacon:');
    expect(redacted).toBe('postgres://localhost:5544/beacon');
  });

  test('strips a password-only userinfo', () => {
    expect(redactUrl('postgres://:s3cret@localhost:5544/beacon')).not.toContain('s3cret');
  });

  test('falls back to a constant (never echoes) on an unparseable URL', () => {
    // Out-of-range port: WHATWG URL throws, so we must not risk echoing the input.
    expect(redactUrl('postgres://u:s3cret@127.0.0.1:99999/db')).toBe('<unparseable-url>');
  });
});
