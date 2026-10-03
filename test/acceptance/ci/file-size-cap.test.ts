import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
// The story card permits this remaining oversized file; exemptions may only be removed.
const EXEMPTIONS = new Set(['packages/beacon-client/src/core/client.test.ts']);

function lineCount(contents: string): number {
  if (contents.length === 0) return 0;
  return contents.split('\n').length - (contents.endsWith('\n') ? 1 : 0);
}

function capViolation(path: string, contents: string): string[] {
  const lines = lineCount(contents);
  return lines > 500 ? [`${path}: ${lines} lines exceeds 500`] : [];
}

describe('TypeScript file-size cap', () => {
  test('tracked TypeScript files stay within 500 lines', () => {
    const result = Bun.spawnSync(['git', 'ls-files', '--cached', '-z', '--', '*.ts'], {
      cwd: REPO_ROOT,
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const paths = [...new Set(result.stdout.toString().split('\0').filter(Boolean))];
    expect(paths.length).toBeGreaterThan(0);
    const violations = paths.flatMap((path) =>
      EXEMPTIONS.has(path) ? [] : capViolation(path, readFileSync(join(REPO_ROOT, path), 'utf8')),
    );
    expect(violations).toEqual([]);
  });

  test('counts physical lines including an unterminated final line', () => {
    expect(lineCount('')).toBe(0);
    expect(lineCount('\n')).toBe(1);
    expect(lineCount('a\n')).toBe(1);
    expect(lineCount('a')).toBe(1);
    expect(lineCount('a\nb')).toBe(2);
    expect(lineCount('a\r\nb\r\n')).toBe(2);
  });

  test('allows exactly 500 lines and rejects 501', () => {
    expect(capViolation('boundary.ts', '\n'.repeat(500))).toEqual([]);
    expect(capViolation('boundary.ts', '\n'.repeat(501))).toEqual([
      'boundary.ts: 501 lines exceeds 500',
    ]);
  });

  test('exemptions only shrink', () => {
    for (const path of EXEMPTIONS) {
      expect(path, `forbidden exemption: ${path}`).toBe(
        'packages/beacon-client/src/core/client.test.ts',
      );
    }
  });
});
