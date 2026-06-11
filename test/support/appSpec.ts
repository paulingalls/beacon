// Shared spec-parse helper for the DigitalOcean App Platform deploy artifacts. Both the
// structural contract guard (test/deploy/spec.test.ts) and the docs-sync check
// (test/acceptance/docs/deployment-runbook.test.ts) re-declared the same EnvVar/Service/Job/
// AppSpec interfaces and the Bun.YAML.parse(.do/app.yaml) wiring; this module is their single
// home (sprint-014 free-session, concern ae0d7d7cfed9).
//
// REPO_ROOT is resolved relative to THIS file's location, not the caller's — so consumers at
// any directory depth import it without re-deriving their own `..` path math.

import { join } from 'node:path';

/** test/support → test → repo root (two levels up from this file). */
export const REPO_ROOT = join(import.meta.dir, '..', '..');

export interface EnvVar {
  key: string;
  value?: string;
  type?: string;
}
export interface Service {
  name?: string;
  dockerfile_path?: string;
  http_port?: number;
  health_check?: { http_path?: string };
  routes?: { path?: string }[];
  envs?: EnvVar[];
}
export interface Job {
  name?: string;
  kind?: string;
  run_command?: string;
  envs?: EnvVar[];
}
export interface Database {
  name?: string;
  engine?: string;
  production?: boolean;
  version?: string;
}
export interface AppSpec {
  name?: string;
  services?: Service[];
  databases?: Database[];
  jobs?: Job[];
}

/** Parse the live `.do/app.yaml` App Platform spec (Bun.YAML is native in Bun 1.3.14). */
export async function loadAppSpec(): Promise<AppSpec> {
  return Bun.YAML.parse(await Bun.file(join(REPO_ROOT, '.do', 'app.yaml')).text()) as AppSpec;
}
