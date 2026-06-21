// Shared test helpers for the private apps/server (DB-backed integration tests).

import { afterAll, beforeAll, beforeEach } from 'bun:test';
import type { Context } from 'hono';
import type { Sql } from 'postgres';

import { closeDb, createDb } from '../src/storage/db';
import { runMigrations } from '../src/storage/migrate';

/** Minimal Hono context carrying (or not) a visitor token. */
export const ctxWith = (token?: string): Context =>
  ({
    get: (key: string) => (key === 'beaconVisitorToken' ? token : undefined),
  }) as unknown as Context;

/**
 * A throwaway tagged-template / `sql(rows)` resolver, used as the transaction
 * handle passed to a stub's begin() callback. Resolves every call inertly.
 */
export const txResolver = (() => Promise.resolve([])) as unknown as Sql;

/**
 * Build a minimal `Sql` test double from a custom `begin()` (plus optional
 * `json`/`end`). The result is callable as both a tagged template (`sql`...``)
 * and the `sql(rows)` insert helper; `json` defaults to a passthrough (it is
 * only a serialization marker) and `end` to a clean resolve. Built untyped then
 * cast — the real postgres.js (TransactionSql) signatures aren't needed here.
 */
export function stubSql(impl: {
  begin: (fn: (tx: Sql) => Promise<unknown>) => Promise<unknown>;
  json?: (value: unknown) => unknown;
  end?: () => Promise<void>;
}): Sql {
  const base = (() => Promise.resolve([])) as unknown as Record<string, unknown> &
    (() => Promise<unknown>);
  base.begin = impl.begin;
  base.json = impl.json ?? ((value: unknown) => value);
  base.end = impl.end ?? (() => Promise.resolve());
  return base as unknown as Sql;
}

/**
 * Registers an integration-DB lifecycle on the enclosing describe block: a
 * migrated client in beforeAll, a TRUNCATE of the event tables before each
 * test, and a clean DROP + close in afterAll. Returns an accessor for the
 * shared client (valid once beforeAll has run, i.e. inside test bodies).
 *
 * Use inside `describe.skipIf(!TEST_DB)` so the hooks only run with a live DB.
 */
export function withTestDb(connectionString: string): () => Sql {
  let sql: Sql;
  beforeAll(async () => {
    sql = createDb({ connectionString });
    await sql`DROP TABLE IF EXISTS beacon_events, beacon_short_links, beacon_meta, beacon_migrations CASCADE`;
    await runMigrations(sql);
  });
  beforeEach(async () => {
    await sql`TRUNCATE beacon_events, beacon_meta`;
  });
  afterAll(async () => {
    await sql`DROP TABLE IF EXISTS beacon_events, beacon_short_links, beacon_meta, beacon_migrations CASCADE`;
    await closeDb(sql);
  });
  return () => sql;
}
