import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Sql } from 'postgres';

import { closeDb, createDb } from './db';

const MIGRATIONS_DIR = join(import.meta.dir, 'migrations');

/**
 * Applies any unapplied SQL migrations in filename order (REQUIREMENTS.md §4.2).
 *
 * Ensures the beacon_migrations ledger exists, then runs all pending files in
 * one transaction (under an advisory lock) and records each. Returns the
 * filenames applied this run — empty when already up to date (idempotent).
 */
// Arbitrary but stable key for the transaction-scoped advisory lock that
// serializes concurrent runners. Two `bun run migrate` invocations against the
// same DB then queue rather than racing the UNIQUE(filename) constraint.
const MIGRATION_LOCK_KEY = 8324_1001;

export async function runMigrations(sql: Sql): Promise<string[]> {
  // Run every pending migration inside one transaction holding a transaction-
  // scoped advisory lock. Concurrent runners queue on the lock and then observe
  // the migrations as already applied, rather than racing the UNIQUE(filename)
  // constraint or the ledger's CREATE-IF-NOT-EXISTS. The lock is acquired first,
  // before any DDL, so even ledger creation is serialized. Auto-releases on
  // commit/rollback.
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`;

    await tx`
      CREATE TABLE IF NOT EXISTS beacon_migrations (
        id          SERIAL PRIMARY KEY,
        filename    TEXT NOT NULL UNIQUE,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

    const appliedRows = await tx<{ filename: string }[]>`SELECT filename FROM beacon_migrations`;
    const alreadyApplied = new Set(appliedRows.map((r) => r.filename));

    const applied: string[] = [];
    for (const file of files) {
      if (alreadyApplied.has(file)) continue;
      const content = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      await tx.unsafe(content);
      await tx`INSERT INTO beacon_migrations (filename) VALUES (${file})`;
      applied.push(file);
    }
    return applied;
  }) as Promise<string[]>;
}

// CLI entry: `bun run migrate` (reads DATABASE_URL per README / §4.2).
if (import.meta.main) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('[beacon] DATABASE_URL is not set — cannot run migrations.');
    process.exit(1);
  }
  const sql = createDb({ connectionString });
  try {
    const applied = await runMigrations(sql);
    console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'No pending migrations.');
  } finally {
    await closeDb(sql);
  }
}
