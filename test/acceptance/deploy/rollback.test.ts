import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Covers the deploy.sh rollback paths (debt: deploy rollback/env-leak paths untested; the
// HEAD@{1} reflog fallback was never proven). scripts/deploy.sh runs ON the droplet: install →
// migrate → restart → health-check, rolling back to the previous commit if the new one is
// unhealthy. We exercise it hermetically — a throwaway git repo as APP_DIR plus PATH stubs for
// the externals (curl/sleep/sudo/systemctl) and a stub BUN — and assert the exit code (0 healthy,
// 1 rolled-back, 2 double-failure) and the git reset target. No droplet, no network, no DB.

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const DEPLOY_SH = join(REPO_ROOT, 'scripts', 'deploy.sh');

// Pin the health-loop count we hand deploy.sh (HEALTH_RETRIES) so the curl stub's
// CURL_HEALTHY_AFTER is derived from it rather than duplicating deploy.sh's default.
// "First restart fails entirely, post-rollback restart succeeds" == HEALTH_RETRIES.
const HEALTH_RETRIES = 20;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim();
}

function commit(repo: string, file: string, content: string, message: string): string {
  writeFileSync(join(repo, file), content);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

function writeStub(dir: string, name: string, body: string): void {
  const p = join(dir, name);
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(p, 0o755);
}

interface RunResult {
  status: number | null;
  stdout: string;
}

describe('deploy.sh rollback', () => {
  let root: string;
  let appDir: string;
  let binDir: string;
  let bunStub: string;
  let envFile: string;
  let counterFile: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'beacon-deploy-'));
    appDir = join(root, 'app');
    binDir = join(root, 'bin');
    mkdirSync(appDir);
    mkdirSync(binDir);
    git(root, 'init', '-q', '-b', 'main', appDir);

    counterFile = join(root, 'curl-calls');
    envFile = join(root, 'env.production');
    writeFileSync(envFile, 'DATABASE_URL=postgres://stub/never-used\n');

    // Stub externals on PATH. `sleep` is a no-op so the health loop runs instantly; `sudo` execs the
    // rest so `sudo systemctl …` hits the systemctl stub. `curl` succeeds once its call count exceeds
    // CURL_HEALTHY_AFTER — letting a test make the 1st restart's full HEALTH_RETRIES-call loop fail and
    // a later call succeed. git/bash/seq stay real (binDir is PREPENDED to PATH).
    writeStub(binDir, 'sleep', 'exit 0');
    writeStub(binDir, 'sudo', 'exec "$@"');
    writeStub(binDir, 'systemctl', 'exit 0');
    writeStub(
      binDir,
      'curl',
      'n=$(cat "$CURL_COUNTER_FILE" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$CURL_COUNTER_FILE"; [ "$n" -gt "$CURL_HEALTHY_AFTER" ]',
    );
    // BUN stub: install / run migrate are no-ops (deploy.sh invokes "$BUN" directly via env).
    bunStub = join(binDir, 'bun-stub');
    writeStub(binDir, 'bun-stub', 'exit 0');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function run(healthyAfter: number): RunResult {
    const res = spawnSync('bash', [DEPLOY_SH], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        APP_DIR: appDir,
        SERVICE: 'beacon-test',
        HEALTH_URL: 'http://localhost:9/health',
        ENV_FILE: envFile,
        BUN: bunStub,
        HEALTH_RETRIES: String(HEALTH_RETRIES),
        CURL_COUNTER_FILE: counterFile,
        CURL_HEALTHY_AFTER: String(healthyAfter),
      },
    });
    return { status: res.status, stdout: res.stdout ?? '' };
  }

  test('healthy first restart → exit 0, no rollback', () => {
    const prev = commit(appDir, 'v', '1', 'A');
    const head = commit(appDir, 'v', '2', 'B');

    const { status, stdout } = run(0); // curl succeeds on call 1

    expect(status).toBe(0);
    expect(stdout).toContain('Deploy healthy');
    // No reset: HEAD stays at the new commit, untouched.
    expect(git(appDir, 'rev-parse', 'HEAD')).toBe(head);
    expect(head).not.toBe(prev);
  });

  test('unhealthy new commit → git reset --hard to HEAD@{1} and exit 1 once healthy', () => {
    const prev = commit(appDir, 'v', '1', 'A'); // HEAD@{1} after the next commit
    const head = commit(appDir, 'v', '2', 'B');

    // First restart's HEALTH_RETRIES health checks all fail (calls 1..HEALTH_RETRIES ≤ threshold);
    // the post-rollback restart's next call succeeds → rolled back and healthy.
    const { status, stdout } = run(HEALTH_RETRIES);

    expect(status).toBe(1);
    expect(stdout).toContain('rolling back');
    expect(stdout).toContain('Rolled back');
    // The working tree was reset to the previous commit.
    expect(git(appDir, 'rev-parse', 'HEAD')).toBe(prev);
    expect(git(appDir, 'rev-parse', 'HEAD')).not.toBe(head);
  });

  test('rollback also unhealthy → exit 2 (manual intervention)', () => {
    commit(appDir, 'v', '1', 'A');
    commit(appDir, 'v', '2', 'B');

    // Threshold above both restarts' combined poll counts → every health check fails.
    const { status, stdout } = run(2 * HEALTH_RETRIES + 1);

    expect(status).toBe(2);
    expect(stdout).toContain('manual intervention required');
  });

  test('HEAD@{1} absent (single commit) → PREV falls back to HEAD', () => {
    // A fresh repo with one commit has no HEAD@{1} reflog entry; deploy.sh must fall back to HEAD
    // rather than crash under `set -euo pipefail`.
    const head = commit(appDir, 'v', '1', 'A');
    const shortHead = head.slice(0, 7);

    // Force the rollback path so the resolved PREV is acted on; reset --hard HEAD is a safe no-op.
    const { status, stdout } = run(HEALTH_RETRIES);

    expect(status).toBe(1); // did not crash on the missing reflog entry
    expect(stdout).toContain(`rollback target: ${shortHead}`);
    expect(git(appDir, 'rev-parse', 'HEAD')).toBe(head);
  });
});
