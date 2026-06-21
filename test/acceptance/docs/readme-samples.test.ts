// Docs-sample check (sprint-013 / Milestone 5, story-001). Proves every TypeScript code
// block in README.md compiles against Beacon's REAL exports — so the integration guide can
// never silently drift from the API a reader is told to call. "Verified, not aspiration."
//
// Mechanism: extract each fenced ts/tsx block, assemble ONE synthetic .tsx module inside the
// repo (so workspace node_modules symlinks resolve `@pi-innovations/*` — the repo has no
// tsconfig `paths` map, only bundler resolution), then run `tsc --noEmit` over it. A block
// that references a non-existent export, a wrong method, or a wrong call signature fails to
// compile and turns this test red.
//
// Host placeholder symbols the docs reference but don't define (createUser, MainNavigator,
// the injected `rn`/`web` bindings, the shared `app`/`beacon`/`client` handles) are supplied
// by a fixed stub PREAMBLE, so the check has teeth on the Beacon surface ONLY — not on
// illustrative host code. Each block is wrapped in its own function so a local `const beacon`
// in one block shadows the ambient handle without colliding with another block.
//
// No Postgres: this is a pure type-check, so it deliberately omits the dbGuard import and
// stays green in the DB-free pre-commit run.

import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..'); // test/acceptance/docs -> repo root
// Both docs carry type-checked samples: README.md (what/why) is mostly prose, INTEGRATION.md
// (how-to) holds the bulk of the code. Scan both so neither can drift from the real exports.
const DOC_FILES = [join(REPO_ROOT, 'README.md'), join(REPO_ROOT, 'INTEGRATION.md')];
const GEN_DIR = join(HERE, '.generated');
const SAMPLE_FILE = join(GEN_DIR, 'readme-samples.tsx');
const TSCONFIG_FILE = join(GEN_DIR, 'tsconfig.json');
const TSC_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'tsc');

// Ambient declarations for everything the README's samples lean on but a host app provides.
// Keeps the type-check focused on whether the BEACON calls are real.
const PREAMBLE = `
import type { HttpBeacon } from '@pi-innovations/beacon-sdk';
import type { BeaconClient as BeaconClientType } from '@pi-innovations/beacon-client';
import type { ReactNativeBindings } from '@pi-innovations/beacon-client/react-native';
import type { WebBindings } from '@pi-innovations/beacon-client/web';

declare const beacon: HttpBeacon;
declare const client: BeaconClientType;
declare const rn: ReactNativeBindings;
declare const web: WebBindings;
declare const request: Request;
declare const otherHeaders: Record<string, string>;
// Minimal JSX namespace so the React Native sample's JSX type-checks without react installed.
declare namespace JSX {
  interface Element {}
  interface IntrinsicElements {
    [name: string]: unknown;
  }
}
declare const MainNavigator: (props?: unknown) => JSX.Element;
`;

/** Pull every fenced ts/tsx/typescript block out of the markdown, in document order. */
function extractBlocks(markdown: string): string[] {
  const fence = /```(?:typescript|tsx|ts)\n([\s\S]*?)```/g;
  const blocks: string[] = [];
  for (let m = fence.exec(markdown); m !== null; m = fence.exec(markdown)) {
    if (m[1] !== undefined) blocks.push(m[1]);
  }
  return blocks;
}

/**
 * Assemble the synthetic module: hoist + dedupe the blocks' imports, then wrap each block's
 * remaining body in its own function so cross-block name reuse (`const beacon = ...`) can't
 * collide. `export default X` becomes `void X` — a function body can't carry an export, but
 * the reference still type-checks.
 */
function buildModule(blocks: string[]): string {
  const imports = new Set<string>();
  const bodies: string[] = [];

  blocks.forEach((block, i) => {
    const kept: string[] = [];
    for (const line of block.split('\n')) {
      // Only hoist TOP-LEVEL imports (column 0). An indented `import ` is a statement
      // inside a block body (e.g. a dynamic import) and must stay where it is.
      if (line.startsWith('import ')) {
        imports.add(line);
        continue;
      }
      const trimmed = line.trim();
      if (trimmed.startsWith('export default ')) {
        kept.push(line.replace('export default ', 'void '));
        continue;
      }
      kept.push(line);
    }
    bodies.push(
      `async function readmeBlock_${i}() {\n${kept.join('\n')}\n}\nvoid readmeBlock_${i};`,
    );
  });

  return [[...imports].join('\n'), PREAMBLE, ...bodies].join('\n\n');
}

afterAll(() => {
  rmSync(GEN_DIR, { recursive: true, force: true });
});

test('every docs TypeScript sample compiles against the real exports', async () => {
  const blocks = DOC_FILES.flatMap((file) => extractBlocks(readFileSync(file, 'utf8')));
  expect(blocks.length).toBeGreaterThan(0); // guard: the extractor must actually find samples

  mkdirSync(GEN_DIR, { recursive: true });
  writeFileSync(SAMPLE_FILE, buildModule(blocks), 'utf8');
  writeFileSync(
    TSCONFIG_FILE,
    JSON.stringify(
      {
        extends: join(REPO_ROOT, 'tsconfig.base.json'),
        compilerOptions: { jsx: 'preserve', noEmit: true },
        files: [SAMPLE_FILE],
      },
      null,
      2,
    ),
    'utf8',
  );

  const proc = Bun.spawn([TSC_BIN, '--noEmit', '-p', TSCONFIG_FILE], {
    cwd: REPO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;

  expect(
    exitCode,
    `Docs samples failed to type-check against current exports:\n${stdout}${stderr}`,
  ).toBe(0);
});
