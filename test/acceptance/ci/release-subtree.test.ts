// release-subtree workflow guard (sprint-022 / Milestone 2, story-001).
// Asserts .github/workflows/release-subtree.yml publishes each SDK package as the root of its
// own git-installable branch: on push to main it git-subtree-splits packages/beacon onto
// sdk-release and packages/beacon-client onto client-release, then force-pushes both. The split
// branches carry no .github/, so they retrigger no workflow; deploy.yml is main-only regardless —
// this test pins that no-retrigger property by asserting deploy's triggers never name a release branch.
//
// Text-parse, DB-free (no dbGuard import): a pure string scan, so it runs in the DB-free pre-commit
// too — mirroring action-pinning.test.ts. Action-pinning of this workflow's `uses:` lines is already
// covered by the all-workflows action-pinning guard, so it is not re-asserted here.

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');

const releaseSubtree = await Bun.file(join(WORKFLOW_DIR, 'release-subtree.yml')).text();
const deploy = await Bun.file(join(WORKFLOW_DIR, 'deploy.yml')).text();

describe('release-subtree workflow', () => {
  test('triggers only on push to main', () => {
    // The `on:` block names exactly one branch — main — under push, and nothing else.
    expect(releaseSubtree).toMatch(/on:\s*\n\s*push:\s*\n\s*branches:\s*\[main\]/);
    // No pull_request / workflow_dispatch / schedule entry would broaden the trigger.
    // workflow_dispatch matters most: a manual trigger could run the force-push off an
    // arbitrary ref, republishing release branches from un-merged code.
    expect(releaseSubtree).not.toMatch(/pull_request:/);
    expect(releaseSubtree).not.toMatch(/workflow_dispatch:/);
    expect(releaseSubtree).not.toMatch(/schedule:/);
  });

  test('grants contents: write for the force-push', () => {
    expect(releaseSubtree).toMatch(/permissions:\s*\n\s*contents:\s*write/);
  });

  test('checks out full history so subtree split can walk it', () => {
    expect(releaseSubtree).toMatch(/fetch-depth:\s*0/);
  });

  test('subtree-splits both packages', () => {
    expect(releaseSubtree).toContain('git subtree split --prefix=packages/beacon');
    expect(releaseSubtree).toContain('git subtree split --prefix=packages/beacon-client');
  });

  test('force-pushes both release branches', () => {
    expect(releaseSubtree).toContain('refs/heads/sdk-release');
    expect(releaseSubtree).toContain('refs/heads/client-release');
    expect(releaseSubtree).toContain('--force');
  });

  test('does not retrigger the droplet deploy — deploy.yml stays main-only', () => {
    // deploy.yml triggers on push to main only; it must never name a release branch.
    expect(deploy).toMatch(/on:\s*\n\s*push:\s*\n\s*branches:\s*\[main\]/);
    expect(deploy).not.toContain('sdk-release');
    expect(deploy).not.toContain('client-release');
  });
});
