import type { Sql } from 'postgres';

import { generateCode } from './codeGen';

/** The value type postgres.js `sql.json()` accepts (mirrors events/buffer.ts). */
type JsonInput = Parameters<Sql['json']>[0];

/** Max code-generation attempts before giving up on collisions (REQUIREMENTS.md §7.1). */
const MAX_CODE_ATTEMPTS = 3;

/** A full beacon_short_links row (REQUIREMENTS.md §4.1). */
export interface ShortLinkRecord {
  code: string;
  destination: string;
  product_id: string;
  campaign: Record<string, unknown>;
  created_at: Date;
  expires_at: Date | null;
  click_count: number;
}

/** The §7.2 create response: the link plus its resolved short url. */
export interface CreatedShortLink {
  code: string;
  destination: string;
  url: string;
  created_at: Date;
  expires_at: Date | null;
}

/** Inputs for createShortLink. `shortDomain` is resolved from config by the mount. */
export interface CreateShortLinkParams {
  destination: string;
  productId: string;
  campaign?: Record<string, unknown>;
  expiresAt?: Date | null;
  shortDomain: string;
}

/**
 * Insert a short link, retrying on code collision (REQUIREMENTS.md §7.1).
 *
 * Generates a code (the generator is injectable so tests can force collisions),
 * then INSERT ... ON CONFLICT (code) DO NOTHING RETURNING *. An empty result
 * means the code was already taken, so retry with a fresh one up to
 * MAX_CODE_ATTEMPTS times before throwing. Returns the §7.2 response shape with
 * `url` built from shortDomain.
 */
export async function createShortLink(
  sql: Sql,
  params: CreateShortLinkParams,
  generate: () => string = generateCode,
): Promise<CreatedShortLink> {
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
    const code = generate();
    const rows = (await sql`
      INSERT INTO beacon_short_links (code, destination, product_id, campaign, expires_at)
      VALUES (
        ${code}, ${params.destination}, ${params.productId},
        ${sql.json((params.campaign ?? {}) as JsonInput)}, ${params.expiresAt ?? null}
      )
      ON CONFLICT (code) DO NOTHING
      RETURNING code, destination, created_at, expires_at`) as unknown as {
      code: string;
      destination: string;
      created_at: Date;
      expires_at: Date | null;
    }[];

    const row = rows[0];
    if (row) {
      // Normalize: strip trailing slashes from shortDomain so a config value
      // like 'https://pi.ink/' yields 'https://pi.ink/CODE', not '...//CODE'.
      const base = params.shortDomain.replace(/\/+$/, '');
      return {
        code: row.code,
        destination: row.destination,
        url: `${base}/${row.code}`,
        created_at: row.created_at,
        expires_at: row.expires_at,
      };
    }
  }
  throw new Error(
    `[beacon] failed to allocate a unique short code after ${MAX_CODE_ATTEMPTS} attempts`,
  );
}

/**
 * Look up a live short link by code (REQUIREMENTS.md §7.2). Returns null for an
 * unknown code or one whose expires_at has passed — the expiry filter lives in
 * SQL so an expired link is indistinguishable from a missing one to callers.
 */
export async function getShortLink(sql: Sql, code: string): Promise<ShortLinkRecord | null> {
  const rows = (await sql`
    SELECT code, destination, product_id, campaign, created_at, expires_at, click_count
    FROM beacon_short_links
    WHERE code = ${code} AND (expires_at IS NULL OR expires_at > now())`) as unknown as ShortLinkRecord[];
  return rows[0] ?? null;
}

/**
 * Increment a link's click counter (REQUIREMENTS.md §7.2). Fire-and-forget on
 * the redirect path: it returns a promise tests can await, but swallows+logs any
 * error so a DB failure never blocks or fails the 302 (§1.3). Callers invoke it
 * without awaiting.
 */
export async function incrementClickCount(sql: Sql, code: string): Promise<void> {
  try {
    await sql`UPDATE beacon_short_links SET click_count = click_count + 1 WHERE code = ${code}`;
  } catch (err) {
    console.warn(`[beacon] incrementClickCount failed for ${code}: ${String(err)}`);
  }
}
