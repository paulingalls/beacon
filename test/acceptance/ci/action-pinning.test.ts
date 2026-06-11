// CI action-pinning guard (sprint-013 / Milestone 5, story-003, closes concern b7133c8d62d8).
// Asserts every `uses:` in the CI workflow references an immutable 40-hex commit SHA — not a
// mutable tag like @v6 that a compromised upstream maintainer could force-move to malicious
// code that then runs in CI. A trailing `# vX.Y.Z` comment keeps the pin human-readable.
//
// DB-free (no dbGuard import): a pure text parse, so it runs in the DB-free pre-commit too.

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const workflow = await Bun.file(join(REPO_ROOT, '.github', 'workflows', 'ci.yml')).text();

// Each `uses:` line, with its referenced action ref (the part after the last @) and the rest
// of the line (to check for the version comment). Matches `uses: owner/repo@<ref>` optionally
// followed by a `# comment`.
const usesLines = workflow
  .split('\n')
  .map((line) => line.match(/uses:\s*(\S+?)@(\S+)/))
  .filter((m): m is RegExpMatchArray => m !== null);

describe('.github/workflows/ci.yml action pinning', () => {
  test('the workflow actually declares actions to pin', () => {
    expect(usesLines.length).toBeGreaterThan(0);
  });

  test('every action is pinned to a full 40-hex commit SHA, not a mutable tag', () => {
    for (const m of usesLines) {
      const [, action, ref] = m;
      expect(ref, `${action} must be pinned to a 40-char commit SHA, got @${ref}`).toMatch(
        /^[0-9a-f]{40}$/,
      );
    }
  });

  test('every pinned action carries a # vX.Y.Z version comment for readability', () => {
    for (const m of usesLines) {
      const line = m.input ?? '';
      expect(line, `${m[1]} pin should carry a # v… version comment`).toMatch(/#\s*v\d/);
    }
  });
});
