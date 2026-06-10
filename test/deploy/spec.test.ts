import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

// Contract guard for the DigitalOcean App Platform deploy artifacts (sprint-012 story-002).
// DB-free: parses .do/app.yaml (Bun.YAML is native in Bun 1.3.14) and reads the Dockerfile,
// asserting the deploy contract holds — so a later edit that drops the PRE_DEPLOY migrate job,
// the Managed Postgres, the secret ADMIN_TOKEN, or the /health check fails loud here. The
// docker-build-and-boot itself is a manual/local E2E criterion, not run in CI.

const REPO_ROOT = join(import.meta.dir, '..', '..');

interface EnvVar {
  key: string;
  value?: string;
  type?: string;
}
interface Service {
  name?: string;
  dockerfile_path?: string;
  http_port?: number;
  health_check?: { http_path?: string };
  routes?: { path?: string }[];
  envs?: EnvVar[];
}
interface Job {
  name?: string;
  kind?: string;
  run_command?: string;
  envs?: EnvVar[];
}
interface Database {
  name?: string;
  engine?: string;
  production?: boolean;
  version?: string;
}
interface AppSpec {
  name?: string;
  services?: Service[];
  databases?: Database[];
  jobs?: Job[];
}

const appSpec = Bun.YAML.parse(
  await Bun.file(join(REPO_ROOT, '.do', 'app.yaml')).text(),
) as AppSpec;
const dockerfile = await Bun.file(join(REPO_ROOT, 'Dockerfile')).text();

describe('.do/app.yaml App Platform spec', () => {
  test('declares exactly one Dockerfile-backed web service', () => {
    expect(appSpec.services).toHaveLength(1);
    expect(appSpec.services?.[0]?.dockerfile_path).toBe('Dockerfile');
  });

  test('web service health check is the DB-free /health on the app port', () => {
    const svc = appSpec.services?.[0];
    expect(svc?.http_port).toBe(8080);
    expect(svc?.health_check?.http_path).toBe('/health');
  });

  test('web service routes the root path so every surface is served', () => {
    expect(appSpec.services?.[0]?.routes?.some((r) => r.path === '/')).toBe(true);
  });

  test('DATABASE_URL binds to the managed DB and ADMIN_TOKEN is a secret', () => {
    const envs = appSpec.services?.[0]?.envs ?? [];
    expect(envs.find((e) => e.key === 'DATABASE_URL')?.value).toContain('beacon-db');
    expect(envs.find((e) => e.key === 'ADMIN_TOKEN')?.type).toBe('SECRET');
  });

  test('declares one production Managed Postgres database', () => {
    expect(appSpec.databases).toHaveLength(1);
    const db = appSpec.databases?.[0];
    expect(db?.engine).toBe('PG');
    expect(db?.production).toBe(true);
    // PG 16 matches docker-compose.yml + ci.yml (postgres:16-alpine) so the deployed
    // engine version equals what tests/CI exercise.
    expect(db?.version).toBe('16');
  });

  test('runs migrations as a PRE_DEPLOY job bound to DATABASE_URL', () => {
    const job = appSpec.jobs?.find((j) => j.kind === 'PRE_DEPLOY');
    expect(job?.run_command).toContain('migrate');
    expect((job?.envs ?? []).some((e) => e.key === 'DATABASE_URL')).toBe(true);
  });
});

describe('Dockerfile', () => {
  test('uses an oven/bun base image', () => {
    expect(dockerfile).toMatch(/^FROM oven\/bun/m);
  });

  test('installs workspace dependencies', () => {
    expect(dockerfile).toContain('bun install');
  });

  test('runs the apps/server entry as its start command', () => {
    expect(dockerfile).toContain('apps/server/src/server.ts');
  });
});
