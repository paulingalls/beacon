import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import type { Sql } from 'postgres';

import { closeDb, createDb } from '../src/storage/db';
import { runMigrations } from '../src/storage/migrate';

const TEST_DB = process.env.TEST_DATABASE_URL;

// Capstone for Milestone 1 (Foundation): proves the seams between the db layer
// (story-002) and the migration runner (story-003) hold together as one flow —
// the milestone's Definition of Done, end to end.
describe.skipIf(!TEST_DB)('Foundation round-trip', () => {
  let sql: Sql;

  beforeAll(async () => {
    sql = createDb({ connectionString: TEST_DB as string });
    await sql`DROP TABLE IF EXISTS beacon_events, beacon_short_links, beacon_meta, beacon_migrations CASCADE`;
  });

  afterAll(async () => {
    await sql`DROP TABLE IF EXISTS beacon_events, beacon_short_links, beacon_meta, beacon_migrations CASCADE`;
    await closeDb(sql);
  });

  test('createDb → runMigrations builds the full §4.1 schema, re-runs as a no-op, and closes cleanly', async () => {
    // First run applies the schema.
    const applied = await runMigrations(sql);
    expect(applied).toContain('001_initial_schema.sql');

    // Every §4.1 table is present.
    const tables = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name LIKE 'beacon_%'`;
    const names = tables.map((r) => r.table_name).sort();
    expect(names).toEqual([
      'beacon_events',
      'beacon_meta',
      'beacon_migrations',
      'beacon_short_links',
    ]);

    // Every §4.1 index is present (name set — column-list fidelity is asserted in migrate.test.ts).
    const indexes = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND indexname LIKE 'idx_beacon_%'`;
    expect(indexes.map((r) => r.indexname).sort()).toEqual([
      'idx_beacon_events_product_time',
      'idx_beacon_events_type',
      'idx_beacon_events_user',
      'idx_beacon_events_visitor',
      'idx_beacon_short_links_product',
    ]);

    // Second run is idempotent.
    const second = await runMigrations(sql);
    expect(second).toEqual([]);

    // closeDb tears down cleanly. Use a throwaway client so the suite's shared
    // handle stays open for afterAll's cleanup.
    const throwaway = createDb({ connectionString: TEST_DB as string });
    await throwaway`SELECT 1`;
    const closeResult = await closeDb(throwaway);
    expect(closeResult).toBeUndefined();
  });
});
