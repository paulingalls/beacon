// INTEGRATION.md git-install docs guard (sprint-022 / Milestone 2, story-003).
// stories 001–002 make each SDK package git-installable as the root of its own release branch
// (sdk-release / client-release, force-pushed by CI). This pins INTEGRATION.md's Installation
// section to the WORKING install lines: a git dep on the monorepo root (#main) installs
// beacon-monorepo and leaves imports unresolved — exactly what M2 fixes — so the doc must point
// consumers at the artifact branches instead.
//
// Text-parse, DB-free (no dbGuard import): readFileSync, so it runs in the DB-free pre-commit too.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const integration = readFileSync(join(REPO_ROOT, 'INTEGRATION.md'), 'utf8');

describe('INTEGRATION.md install docs', () => {
  test('documents the SDK artifact-branch git install', () => {
    expect(integration).toContain('git+https://github.com/paulingalls/beacon.git#sdk-release');
  });

  test('documents the client artifact-branch git install', () => {
    expect(integration).toContain('git+https://github.com/paulingalls/beacon.git#client-release');
  });

  test('no longer documents the broken monorepo-root git dependency', () => {
    // A git dep of the repo root (#main) installs beacon-monorepo, so imports never resolve —
    // the failure M2 removes. The artifact branches above replace it.
    expect(integration).not.toContain('beacon.git#main');
  });
});
