import { describe, expect, spyOn, test } from 'bun:test';

import { closeDb, createDb } from './db';

const TEST_DB = process.env.TEST_DATABASE_URL;

describe('createDb failure isolation', () => {
  test('does not throw on a malformed connection string', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    let sql: ReturnType<typeof createDb> | undefined;
    expect(() => {
      sql = createDb({ connectionString: 'postgres://u:p@127.0.0.1:99999/db' });
    }).not.toThrow();
    void sql?.end({ timeout: 1 }).catch(() => {});
    warn.mockRestore();
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
