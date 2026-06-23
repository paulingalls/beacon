// Additive-only migration guard (sprint-023, story-002, adopted migration-debt Try).
//
// runMigrations (apps/server/src/storage/migrate.ts) records applied migrations by FILENAME in
// the beacon_migrations ledger and skips any filename already applied — so editing the content of
// an already-applied migration is a silent no-op in production (the edited SQL never re-runs and
// the file diverges from the live schema). This guard makes that drift loud: a committed
// checksums.sha256 manifest pins each migration's bytes, and the live test below fails the instant
// an applied migration's content changes, a recorded migration is deleted, or a new migration is
// added without registering its checksum.
//
// Additive workflow: a new migration = a new .sql file AND a new line appended to
// checksums.sha256. Never edit an applied migration — add a higher-numbered one instead.
//
// DB-free (no dbGuard import): a pure hash/text compare, so it runs in the DB-free pre-commit too,
// mirroring test/acceptance/ci/action-pinning.test.ts.

import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const MIGRATIONS_DIR = join(REPO_ROOT, 'apps', 'server', 'src', 'storage', 'migrations');
const MANIFEST_FILE = join(MIGRATIONS_DIR, 'checksums.sha256');

/** sha256 hex of a file's raw bytes. */
function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Parse sha256sum-style `<hex>  <filename>` lines into a filename→hash map (blank lines skipped). */
function parseManifest(text: string): Map<string, string> {
  const manifest = new Map<string, string>();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const [hash, file] = trimmed.split(/\s+/);
    if (hash && file) manifest.set(file, hash);
  }
  return manifest;
}

/**
 * Compare the current migrations (filename→hash) against the committed manifest and return a
 * human-readable violation message per breach. Empty array = additive-only invariant holds.
 *   1. a manifest entry whose file is gone  → an applied migration was deleted
 *   2. a manifest entry whose hash differs   → an applied migration's content was edited
 *   3. a current file absent from the manifest → a new migration wasn't registered
 */
export function checkMigrationsAdditive(
  current: Map<string, string>,
  manifest: Map<string, string>,
): string[] {
  const violations: string[] = [];
  for (const [file, hash] of manifest) {
    if (!current.has(file)) {
      violations.push(
        `migration ${file} is in checksums.sha256 but missing from migrations/ — applied migrations must never be deleted`,
      );
    } else if (current.get(file) !== hash) {
      violations.push(
        `migration ${file} content changed (checksum mismatch) — applied migrations are immutable; add a new migration instead`,
      );
    }
  }
  for (const file of current.keys()) {
    if (!manifest.has(file)) {
      violations.push(
        `migration ${file} is not registered in checksums.sha256 — append its checksum line (additive-only)`,
      );
    }
  }
  return violations;
}

describe('checkMigrationsAdditive (pure checker)', () => {
  test('flags an applied migration whose content changed (checksum mismatch)', () => {
    const current = new Map([['001_a.sql', 'hash-NEW']]);
    const manifest = new Map([['001_a.sql', 'hash-OLD']]);
    const violations = checkMigrationsAdditive(current, manifest);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('001_a.sql');
    expect(violations[0]).toContain('checksum mismatch');
  });

  test('flags a recorded migration that was deleted', () => {
    const current = new Map<string, string>();
    const manifest = new Map([['001_a.sql', 'hash-OLD']]);
    const violations = checkMigrationsAdditive(current, manifest);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('001_a.sql');
    expect(violations[0]).toContain('never be deleted');
  });

  test('flags a new migration that is not registered in the manifest', () => {
    const current = new Map([
      ['001_a.sql', 'h1'],
      ['002_b.sql', 'h2'],
    ]);
    const manifest = new Map([['001_a.sql', 'h1']]);
    const violations = checkMigrationsAdditive(current, manifest);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('002_b.sql');
    expect(violations[0]).toContain('not registered');
  });

  test('passes when every migration matches its manifest entry', () => {
    const current = new Map([
      ['001_a.sql', 'h1'],
      ['002_b.sql', 'h2'],
    ]);
    const manifest = new Map([
      ['001_a.sql', 'h1'],
      ['002_b.sql', 'h2'],
    ]);
    expect(checkMigrationsAdditive(current, manifest)).toEqual([]);
  });

  test('passes when a new migration is added AND registered (additive workflow)', () => {
    const current = new Map([
      ['001_a.sql', 'h1'],
      ['003_c.sql', 'h3'],
    ]);
    const manifest = new Map([
      ['001_a.sql', 'h1'],
      ['003_c.sql', 'h3'],
    ]);
    expect(checkMigrationsAdditive(current, manifest)).toEqual([]);
  });
});

describe('parseManifest', () => {
  test('parses sha256sum-style lines into a filename→hash map, skipping blanks', () => {
    const manifest = parseManifest('abc123  001_a.sql\n\ndef456  002_b.sql\n');
    expect(manifest.get('001_a.sql')).toBe('abc123');
    expect(manifest.get('002_b.sql')).toBe('def456');
    expect(manifest.size).toBe(2);
  });
});

describe('live additive-only guard (real migrations vs committed manifest)', () => {
  test('the committed checksums.sha256 matches the real migrations', () => {
    const sqlFiles = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    const current = new Map(
      sqlFiles.map((f) => [f, sha256(readFileSync(join(MIGRATIONS_DIR, f)))]),
    );
    const manifest = parseManifest(readFileSync(MANIFEST_FILE, 'utf8'));
    expect(checkMigrationsAdditive(current, manifest)).toEqual([]);
  });
});
