// Docs-sync check (sprint-013 / Milestone 5, story-002). Proves docs/DEPLOYMENT.md documents
// the LIVE .do/app.yaml deploy spec — so the runbook can't silently drift from the artifact an
// operator actually deploys. The teeth are derived from the parsed spec: every env key and job
// the spec declares MUST appear in the runbook, so a future env/job added to app.yaml without a
// runbook update turns this test red.
//
// DB-free (no dbGuard import): pure file reads + Bun.YAML, so it runs in the DB-free pre-commit
// too. Mirrors the structural contract guard in test/deploy/spec.test.ts.

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');

interface EnvVar {
  key: string;
}
interface Service {
  envs?: EnvVar[];
}
interface Job {
  name?: string;
  envs?: EnvVar[];
}
interface AppSpec {
  services?: Service[];
  jobs?: Job[];
}

const appSpec = Bun.YAML.parse(
  await Bun.file(join(REPO_ROOT, '.do', 'app.yaml')).text(),
) as AppSpec;
const runbook = await Bun.file(join(REPO_ROOT, 'docs', 'DEPLOYMENT.md')).text();

// Every env key the spec actually declares (web service + jobs), deduped.
const specEnvKeys = [
  ...new Set([
    ...(appSpec.services ?? []).flatMap((s) => (s.envs ?? []).map((e) => e.key)),
    ...(appSpec.jobs ?? []).flatMap((j) => (j.envs ?? []).map((e) => e.key)),
  ]),
];
const specJobNames = (appSpec.jobs ?? []).map((j) => j.name).filter((n): n is string => !!n);

describe('docs/DEPLOYMENT.md deploy runbook', () => {
  test('the runbook exists and is substantial', () => {
    expect(runbook.length).toBeGreaterThan(500);
  });

  test('documents every env key the .do/app.yaml spec declares', () => {
    expect(specEnvKeys.length).toBeGreaterThan(0); // guard: parsed at least one env
    for (const key of specEnvKeys) {
      expect(runbook, `runbook must document env var ${key}`).toContain(key);
    }
  });

  test('documents every job the .do/app.yaml spec declares', () => {
    expect(specJobNames).toContain('migrate'); // guard: the migrate job is parsed
    for (const name of specJobNames) {
      expect(runbook, `runbook must document the ${name} job`).toContain(name);
    }
  });

  test('walks the doctl create-from-spec command', () => {
    expect(runbook).toContain('doctl apps create --spec .do/app.yaml');
  });

  test('includes smoke checks for /health and a short-link 302 redirect', () => {
    expect(runbook).toContain('/health');
    expect(runbook).toMatch(/302|redirect/i);
  });
});
