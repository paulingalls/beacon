import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadAppSpec, REPO_ROOT } from './appSpec';

// Behavior guard for the shared spec-parse helper. The two deploy/docs suites exercise it
// against the live .do/app.yaml, but this asserts the helper's own contract directly: it
// resolves the repo root (independent of caller depth) and returns the parsed top-level shape.

describe('loadAppSpec', () => {
  test('REPO_ROOT resolves to the repo root regardless of caller depth', () => {
    expect(existsSync(join(REPO_ROOT, '.do', 'app.yaml'))).toBe(true);
    expect(existsSync(join(REPO_ROOT, 'package.json'))).toBe(true);
  });

  test('parses the live spec into its top-level shape', async () => {
    const spec = await loadAppSpec();
    expect(spec.services?.length).toBeGreaterThan(0);
    expect(spec.databases?.length).toBeGreaterThan(0);
    expect(spec.jobs?.length).toBeGreaterThan(0);
  });
});
