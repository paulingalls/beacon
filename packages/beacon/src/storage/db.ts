import postgres, { type Options, type Sql } from 'postgres';

export interface DbConfig {
  /** Postgres connection string, e.g. postgres://user:pass@host:5432/db. */
  connectionString: string;
  /** Connection pool size. Defaults to 10 (REQUIREMENTS.md §10). */
  maxConnections?: number;
}

/**
 * Creates a postgres.js client.
 *
 * Failure isolation (REQUIREMENTS.md §1.3): this never throws. postgres.js
 * connects lazily, so a well-formed-but-unreachable host surfaces only when a
 * query runs — we fire a non-blocking connectivity probe that logs a warning
 * on failure without rejecting to the caller. A malformed connection string
 * that throws at construction is caught and logged; callers still receive a
 * usable Sql whose queries reject, so the event buffer's retry path (Phase 2)
 * handles the failure rather than the host app crashing.
 */
export function createDb(config: DbConfig): Sql {
  const options: Options<Record<string, never>> = {
    max: config.maxConnections ?? 10,
    onnotice: () => {},
  };

  let sql: Sql;
  try {
    sql = postgres(config.connectionString, options);
  } catch (err) {
    console.warn(`[beacon] failed to initialize Postgres client: ${String(err)}`);
    // Bind to an unreachable placeholder so the caller gets a usable Sql whose
    // queries reject, instead of a throw that would crash the host app.
    sql = postgres({ ...options, host: '127.0.0.1', port: 1, connect_timeout: 1 });
  }

  // Non-blocking startup connectivity probe — warn on failure, never reject.
  void sql`select 1`.catch((err: unknown) => {
    console.warn(`[beacon] Postgres connectivity probe failed: ${String(err)}`);
  });

  return sql;
}

/** Closes the connection, draining in-flight queries within a 5s timeout. */
export async function closeDb(sql: Sql): Promise<void> {
  await sql.end({ timeout: 5 });
}
