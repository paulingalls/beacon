import { describe, expect, spyOn, test } from 'bun:test';

import { closeDb, createDb } from './db';

const TEST_DB = process.env.TEST_DATABASE_URL;

// db-coverage guard (decision a02afa9ca404): a silent skip hides coverage gaps. Fail loud when
// the DB is expected but unset; the only sanctioned skip is the explicit BEACON_TEST_DB=off opt-out.
test('DB coverage: TEST_DATABASE_URL is set unless the DB is explicitly opted out', () => {
  expect(Boolean(TEST_DB) || process.env.BEACON_TEST_DB === 'off').toBe(true);
});

describe('createDb failure isolation', () => {
  test('does not throw on a malformed connection string, and warns', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    let sql: ReturnType<typeof createDb> | undefined;
    expect(() => {
      sql = createDb({ connectionString: 'postgres://u:p@127.0.0.1:99999/db' });
    }).not.toThrow();
    // An out-of-range port throws synchronously at construction, so the catch
    // branch fires and warns immediately — this assertion proves that branch is
    // live (the connectivity-probe warning is async and would not be visible yet).
    expect(warn).toHaveBeenCalled();
    void sql?.end({ timeout: 1 }).catch(() => {});
    warn.mockRestore();
  });

  test('a malformed connection string yields a reject-on-query stub whose end() resolves', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const sql = createDb({ connectionString: 'postgres://u:p@127.0.0.1:99999/db' });
    // The fallback is an explicit stub: queries reject with a clear beacon error
    // (no real socket, no connect_timeout wait), and end() resolves cleanly.
    // This keeps the §1.3 never-throw contract airtight (debt e8b3cf6b0af9).
    await expect(sql`select 1`).rejects.toThrow(/beacon.*unavailable/i);
    await expect(closeDb(sql)).resolves.toBeUndefined();
    warn.mockRestore();
  });

  test('applies the connection pool size (default 10, passthrough otherwise)', () => {
    const def = createDb({ connectionString: 'postgres://u:p@127.0.0.1:5544/db' });
    expect(def.options.max).toBe(10);
    void def.end({ timeout: 1 }).catch(() => {});

    const custom = createDb({
      connectionString: 'postgres://u:p@127.0.0.1:5544/db',
      maxConnections: 3,
    });
    expect(custom.options.max).toBe(3);
    void custom.end({ timeout: 1 }).catch(() => {});
  });

  test('does not throw on a well-formed but unreachable host, and warns', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const sql = createDb({ connectionString: 'postgres://u:p@127.0.0.1:1/db' });
    // The connectivity probe is fire-and-forget; give the refused connection a moment.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(warn).toHaveBeenCalled();
    await sql.end({ timeout: 1 }).catch(() => {});
    warn.mockRestore();
  });
});

describe.skipIf(!TEST_DB)('createDb against a live Postgres', () => {
  test('returns a working client that runs a query', async () => {
    const sql = createDb({ connectionString: TEST_DB as string });
    const rows = await sql`select 1 as one`;
    expect(rows[0]?.one).toBe(1);
    await closeDb(sql);
  });

  test('closeDb closes the connection cleanly', async () => {
    const sql = createDb({ connectionString: TEST_DB as string });
    await sql`select 1`;
    const result = await closeDb(sql);
    expect(result).toBeUndefined();
  });
});
