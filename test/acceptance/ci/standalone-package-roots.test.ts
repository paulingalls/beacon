// Standalone package-root guard (sprint-022 / Milestone 2, story-002).
// The release-subtree workflow (story-001) force-pushes packages/beacon and packages/beacon-client
// as the ROOT of their own git-installable branches (sdk-release / client-release). The monorepo
// workspace config does NOT propagate through a subtree split, so each package.json must resolve
// standalone as that branch root: every exports target must exist relative to the package dir, the
// SDK's ./hono subpath must declare hono so it builds without root hoisting (closes 0ed9c57fca96),
// and beacon-client must stay zero-runtime-deps so its branch root installs nothing transitive.
//
// Text-parse, DB-free (no dbGuard import): readFileSync + JSON.parse, mirroring
// singleWriterBoundary.acceptance.test.ts — so it runs in the DB-free pre-commit too.

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');

type PackageJson = {
  exports?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

function readPkg(relDir: string): { dir: string; pkg: PackageJson } {
  const dir = join(REPO_ROOT, relDir);
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PackageJson;
  return { dir, pkg };
}

const sdk = readPkg('packages/beacon');
const client = readPkg('packages/beacon-client');

describe('standalone package roots', () => {
  // A consumer that `bun add`s the split branch root resolves these exports relative to the
  // package dir, with no monorepo root to fall back on — so every target must exist on disk.
  for (const { name, dir, pkg } of [
    { name: 'beacon-sdk', dir: sdk.dir, pkg: sdk.pkg },
    { name: 'beacon-client', dir: client.dir, pkg: client.pkg },
  ]) {
    test(`${name}: every exports target resolves relative to the package root`, () => {
      const entries = Object.entries(pkg.exports ?? {});
      expect(entries.length).toBeGreaterThan(0);
      for (const [subpath, target] of entries) {
        // Today every target is a flat string. A future conditional-exports object
        // ({ import: '…' }) would make join(dir, target) throw a cryptic TypeError; assert the
        // shape first so the failure names the offending export instead.
        expect(typeof target, `${name}: export "${subpath}" is not a string target`).toBe('string');
        expect(existsSync(join(dir, target)), `${name}: missing export target ${target}`).toBe(
          true,
        );
      }
    });
  }

  test('beacon-sdk declares hono as a devDependency (closes 0ed9c57fca96)', () => {
    expect(sdk.pkg.devDependencies?.hono).toBeDefined();
  });

  test('beacon-sdk keeps hono an optional peerDependency for agnostic consumers', () => {
    expect(sdk.pkg.peerDependencies?.hono).toBeDefined();
    expect(sdk.pkg.peerDependenciesMeta?.hono?.optional).toBe(true);
  });

  test('beacon-client declares zero runtime dependencies', () => {
    expect(Object.keys(client.pkg.dependencies ?? {})).toEqual([]);
  });
});
