// Release-artifacts round-trip capstone (sprint-022 / Milestone 2, story-004).
// Proves the seam stories 001–003 built end to end: a REAL `git subtree split` of each package
// (the same command .github/workflows/release-subtree.yml runs) produces a root that a fresh
// consumer OUTSIDE the monorepo can install and import BY PACKAGE NAME —
//   import { createHttpBeacon } from '@pi-innovations/beacon-sdk'   resolves from the split root,
// not the monorepo root. That is exactly Milestone 2's `done` criterion. The real sdk-release /
// client-release branches only exist after a merge-to-main CI run, so this simulates the split
// hermetically (split -> archive -> bun add a local copy) rather than pulling the live remote.
//
// DB-free (no dbGuard import): pure subprocess + filesystem, so it runs in the DB-free pre-commit
// too. Subprocess + temp-dir idiom mirrors test/acceptance/deploy/rollback.test.ts.

import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const SHA_RE = /^[0-9a-f]{40}$/;

const PACKAGES = [
  { prefix: 'packages/beacon', name: '@pi-innovations/beacon-sdk', symbol: 'createHttpBeacon' },
  {
    prefix: 'packages/beacon-client',
    name: '@pi-innovations/beacon-client',
    symbol: 'BeaconClient',
  },
] as const;

// Temp dirs created across the run; removed in afterEach so a failing assertion never leaks them.
const scratch: string[] = [];
function mkscratch(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `beacon-roundtrip-${tag}-`));
  scratch.push(dir);
  return dir;
}

afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop() as string, { recursive: true, force: true });
});

/** Run a command, returning status + captured streams (never throws on non-zero — we assert). */
function run(cmd: string, args: string[], cwd: string) {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env } });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

describe('release artifacts round-trip', () => {
  for (const { prefix, name, symbol } of PACKAGES) {
    test(`E2E: subtree-split ${prefix} installs + imports ${symbol} from the split root`, () => {
      const base = mkscratch(prefix.split('/').pop() as string);
      const pkgDir = join(base, 'pkg');
      const consumerDir = join(base, 'consumer');
      const tarPath = join(base, 'split.tar');
      mkdirSync(pkgDir);
      mkdirSync(consumerDir);

      // 1. Real subtree split — the same command release-subtree.yml runs. The SHA prints to
      //    stdout; progress goes to stderr. Take the last non-empty stdout line.
      const splitOut = execFileSync('git', ['subtree', 'split', `--prefix=${prefix}`], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
      const sha = splitOut.trim().split('\n').filter(Boolean).pop() ?? '';
      expect(sha, `subtree split produced no SHA for ${prefix}`).toMatch(SHA_RE);

      // 2. Materialize the split commit's tree — its root IS the package (package.json + src/).
      execFileSync('git', ['archive', '--format=tar', '-o', tarPath, sha], { cwd: REPO_ROOT });
      execFileSync('tar', ['-xf', tarPath, '-C', pkgDir]);

      // 3. Fresh consumer project OUTSIDE the monorepo (no workspace parent to shadow the import).
      writeFileSync(
        join(consumerDir, 'package.json'),
        `${JSON.stringify({ name: 'beacon-consumer', version: '0.0.0', private: true }, null, 2)}\n`,
      );
      writeFileSync(
        join(consumerDir, 'consumer.ts'),
        `import { ${symbol} } from '${name}';\n` +
          `if (typeof ${symbol} !== 'function') process.exit(3);\n` +
          `console.log('ok:' + import.meta.resolve('${name}'));\n`,
      );

      // 4a. Install the split root as a local dependency (no registry/network: the SDK has no
      //     runtime deps; hono is an optional peer that is skipped).
      const add = run('bun', ['add', pkgDir], consumerDir);
      expect(add.status, `bun add failed for ${name}:\n${add.stderr}`).toBe(0);

      // 4b. Run the consumer — the bare-name import must resolve and the symbol must be callable.
      const ran = run('bun', ['run', 'consumer.ts'], consumerDir);
      expect(ran.status, `consumer failed to import ${name}:\n${ran.stderr}`).toBe(0);

      const line = ran.stdout.trim().split('\n').filter(Boolean).pop() ?? '';
      expect(line.startsWith('ok:'), `unexpected consumer output: ${ran.stdout}`).toBe(true);
      // The bare name resolves to the installed split copy's OWN root entry (`src/index.ts`
      // directly at the package root — proving the branch root IS the package), and NOT the
      // monorepo: the path is neither under REPO_ROOT nor in its `packages/<x>` layout. That is
      // Milestone 2's `done` criterion.
      const resolved = line.slice('ok:'.length);
      expect(resolved.endsWith('/src/index.ts'), `resolved unexpectedly: ${resolved}`).toBe(true);
      expect(resolved).not.toContain(REPO_ROOT);
      expect(resolved).not.toContain('/packages/');
    }, 60_000);
  }
});
