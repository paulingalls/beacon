import postgres, { type Options, type Sql } from 'postgres';

/** The value type postgres.js `sql.json()` accepts. One shared home for the cast. */
export type JsonInput = Parameters<Sql['json']>[0];

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
    // Construction failed (e.g. a malformed connection string). Return a stub
    // whose queries reject immediately — the buffer's retry path handles the
    // failure (§1.3) — rather than a throw that would crash the host app or a
    // real client to an unreachable host that blocks on connect timeouts.
    return rejectingSql(options.max ?? 10);
  }

  // Non-blocking startup connectivity probe — warn on failure, never reject.
  void sql`select 1`.catch((err: unknown) => {
    console.warn(`[beacon] Postgres connectivity probe failed: ${String(err)}`);
  });

  return sql;
}

/**
 * A minimal Sql whose every query rejects with a clear error and whose end()
 * resolves cleanly. Returned by createDb when the real client can't be
 * constructed, so callers get a usable handle that never throws and never
 * blocks on a real connection (REQUIREMENTS.md §1.3).
 */
function rejectingSql(max: number): Sql {
  const reject = (): Promise<never> =>
    Promise.reject(
      new Error('[beacon] Postgres client unavailable (createDb failed to initialize)'),
    );
  // Built untyped then cast once — typing against the real Sql signatures isn't
  // needed. Callable as both a tagged template (`sql`...``) and the row helper
  // (`sql(rows)`). json() passes its value through (it is only a serialization
  // marker); begin() and queries reject; end() resolves.
  const stub = (() => reject()) as unknown as Record<string, unknown> & (() => Promise<never>);
  stub.begin = () => reject();
  stub.json = (value: unknown) => value;
  stub.end = () => Promise.resolve();
  stub.options = { max };
  return stub as unknown as Sql;
}

/** Closes the connection, draining in-flight queries within a 5s timeout. */
export async function closeDb(sql: Sql): Promise<void> {
  await sql.end({ timeout: 5 });
}
