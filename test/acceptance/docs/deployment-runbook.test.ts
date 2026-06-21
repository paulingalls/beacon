// Docs-sync guard for the droplet deploy runbook (free-2026-06-21-live-do-deploy; replaces the
// old App Platform .do/app.yaml parse-driven check, retired with that spec).
//
// There is no single machine-readable spec for a droplet deploy (the Caddyfile, systemd unit,
// and deploy scripts are separate artifacts), so instead of parsing a spec this asserts that
// docs/DEPLOYMENT.md names the load-bearing facts an operator needs — the runtime artifacts, the
// env vars the host reads, and the non-obvious managed-PG/Caddy steps that bit us live. If the
// runbook drifts away from how Beacon actually deploys, this fails.
//
// DB-free (no dbGuard import): a pure text read, so it runs in the DB-free pre-commit too.

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const runbook = await Bun.file(join(REPO_ROOT, 'docs', 'DEPLOYMENT.md')).text();

describe('docs/DEPLOYMENT.md droplet runbook', () => {
  // The runtime artifacts the runbook must point an operator at.
  test.each([
    'deploy/beacon.service', // systemd unit
    'deploy/Caddyfile', // reverse proxy / TLS
    'scripts/provision-droplet.sh', // one-shot provisioning
    'scripts/deploy.sh', // on-droplet deploy
    '/health', // smoke check
    '.env.production', // where secrets live on the droplet
  ])('references the deploy artifact %s', (artifact) => {
    expect(runbook).toContain(artifact);
  });

  // Every env var the host (apps/server) reads must be documented so an operator knows what to
  // put in .env.production. DATABASE_URL/ADMIN_TOKEN/SHORT_DOMAIN are the ones that matter in prod;
  // TRUSTED_INGEST_TOKEN gates trusted s2s ingest (M2).
  test.each([
    'DATABASE_URL',
    'ADMIN_TOKEN',
    'SHORT_DOMAIN',
    'TRUSTED_INGEST_TOKEN',
  ])('documents the %s environment variable', (key) => {
    expect(runbook).toContain(key);
  });

  // The non-obvious managed-PG + Caddy steps discovered during the first live bring-up — omitting
  // any one of these leaves the deploy broken in a way the happy-path docs would hide.
  test('documents the managed-PG trusted-sources firewall step', () => {
    expect(runbook.toLowerCase()).toContain('trusted source');
  });

  test('documents granting the DB user schema privileges (PG15+ has no default CREATE)', () => {
    expect(runbook).toMatch(/GRANT[\s\S]*SCHEMA public/i);
  });

  test('documents reloading Caddy after provisioning installs the Caddyfile', () => {
    expect(runbook.toLowerCase()).toContain('reload caddy');
  });
});
