import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import type { Sql } from 'postgres';

import { closeDb, createDb } from './db';
import { runMigrations } from './migrate';

const TEST_DB = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DB)('runMigrations against a live Postgres', () => {
  // Constructed in beforeAll, not at describe-body eval time, so a skipped suite
  // (TEST_DATABASE_URL unset, e.g. the pre-commit hook) never opens a stray
  // connection to whatever Postgres happens to be on localhost.
  let sql: Sql;

  beforeAll(() => {
    sql = createDb({ connectionString: TEST_DB as string });
  });

  beforeEach(async () => {
    await sql`DROP TABLE IF EXISTS beacon_events, beacon_short_links, beacon_meta, beacon_migrations CASCADE`;
  });

  afterAll(async () => {
    await sql`DROP TABLE IF EXISTS beacon_events, beacon_short_links, beacon_meta, beacon_migrations CASCADE`;
    await closeDb(sql);
  });

  const tableExists = async (name: string): Promise<boolean> => {
    const rows = await sql<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ${name}
      ) AS exists`;
    return rows[0]?.exists ?? false;
  };

  const indexDef = async (name: string): Promise<string | null> => {
    const rows = await sql<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = ${name}`;
    return rows[0]?.indexdef ?? null;
  };

  const columnInfo = async (
    table: string,
    column: string,
  ): Promise<{ data_type: string; is_nullable: string; column_default: string | null } | null> => {
    const rows = await sql<
      { data_type: string; is_nullable: string; column_default: string | null }[]
    >`
      SELECT data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}`;
    return rows[0] ?? null;
  };

  test('applies 001_initial_schema.sql and reports it', async () => {
    const applied = await runMigrations(sql);
    expect(applied).toContain('001_initial_schema.sql');
  });

  test('creates all four core tables', async () => {
    await runMigrations(sql);
    expect(await tableExists('beacon_events')).toBe(true);
    expect(await tableExists('beacon_short_links')).toBe(true);
    expect(await tableExists('beacon_meta')).toBe(true);
    expect(await tableExists('beacon_migrations')).toBe(true);
  });

  test('creates indexes with the exact column lists from REQUIREMENTS §4.1', async () => {
    await runMigrations(sql);
    // Assert the column expressions, not just index-name existence — a
    // correctly-named index on the wrong columns must fail (concern f07411babf8a).
    expect(await indexDef('idx_beacon_events_product_time')).toContain(
      '(product_id, "timestamp" DESC)',
    );
    const userIdx = (await indexDef('idx_beacon_events_user')) ?? '';
    expect(userIdx).toContain('(user_id, "timestamp" DESC)');
    expect(userIdx).toContain('user_id IS NOT NULL');
    const visitorIdx = (await indexDef('idx_beacon_events_visitor')) ?? '';
    expect(visitorIdx).toContain('(visitor_token)');
    expect(visitorIdx).toContain('visitor_token IS NOT NULL');
    expect(await indexDef('idx_beacon_events_type')).toContain(
      '(product_id, event_type, "timestamp" DESC)',
    );
    expect(await indexDef('idx_beacon_short_links_product')).toContain('(product_id)');
  });

  test('beacon_short_links has click_count INTEGER NOT NULL DEFAULT 0', async () => {
    await runMigrations(sql);
    const col = await columnInfo('beacon_short_links', 'click_count');
    expect(col?.data_type).toBe('integer');
    expect(col?.is_nullable).toBe('NO');
    expect(col?.column_default).toBe('0');
  });

  test('JSONB columns are NOT NULL with default {}', async () => {
    await runMigrations(sql);
    for (const [table, column] of [
      ['beacon_events', 'properties'],
      ['beacon_events', 'context'],
      ['beacon_events', 'attribution'],
      ['beacon_short_links', 'campaign'],
    ] as const) {
      const col = await columnInfo(table, column);
      expect(col?.data_type).toBe('jsonb');
      expect(col?.is_nullable).toBe('NO');
    }
  });

  test('is idempotent — a second run applies nothing', async () => {
    await runMigrations(sql);
    const second = await runMigrations(sql);
    expect(second).toEqual([]);
  });

  test('records the applied filename in beacon_migrations', async () => {
    await runMigrations(sql);
    const rows = await sql<{ filename: string }[]>`SELECT filename FROM beacon_migrations`;
    expect(rows.map((r) => r.filename)).toContain('001_initial_schema.sql');
  });
});
