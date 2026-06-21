// CI action-pinning guard (sprint-013 / Milestone 5, story-003, closes concern b7133c8d62d8;
// widened to all workflows when deploy.yml was added).
// Asserts every external `uses:` in EVERY workflow references an immutable 40-hex commit SHA —
// not a mutable tag like @v6 that a compromised upstream maintainer could force-move to malicious
// code that then runs in CI. A trailing `# vX.Y.Z` comment keeps the pin human-readable.
//
// Scans .github/workflows/*.yml (not just ci.yml) so deploy.yml and any future workflow are
// covered the moment they land. Local reusable-workflow calls (`uses: ./.github/workflows/x.yml`)
// have no `@ref`, so the regex skips them — only external owner/repo@ref actions are pinned.
//
// DB-free (no dbGuard import): a pure text parse, so it runs in the DB-free pre-commit too.

import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');

// readdirSync is sync; Bun.file().text() is async — kick off one read per workflow file, then
// resolve them all up front so the parsing below works against plain strings.
const workflowFiles = readdirSync(WORKFLOW_DIR)
  .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
  .map((name) => ({ name, text: Bun.file(join(WORKFLOW_DIR, name)).text() }));

const workflows = await Promise.all(
  workflowFiles.map(async ({ name, text }) => ({ name, text: await text })),
);

const matches = workflows.flatMap(({ name, text }) =>
  text
    .split('\n')
    .map((line) => line.match(/uses:\s*(\S+?)@(\S+)/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ name, action: m[1], ref: m[2], line: m.input ?? '' })),
);

describe('.github/workflows action pinning (all workflows)', () => {
  test('the workflows actually declare external actions to pin', () => {
    expect(matches.length).toBeGreaterThan(0);
  });

  test('every external action is pinned to a full 40-hex commit SHA, not a mutable tag', () => {
    for (const { name, action, ref } of matches) {
      expect(ref, `${name}: ${action} must be pinned to a 40-char commit SHA, got @${ref}`).toMatch(
        /^[0-9a-f]{40}$/,
      );
    }
  });

  test('every pinned action carries a # vX.Y.Z version comment for readability', () => {
    for (const { name, action, line } of matches) {
      expect(line, `${name}: ${action} pin should carry a # v… version comment`).toMatch(/#\s*v\d/);
    }
  });
});
