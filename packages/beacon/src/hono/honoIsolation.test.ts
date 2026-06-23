import { describe, expect, test } from 'bun:test';

// Import-isolation proof for Milestone 1 (execution_plan.json §Milestone 1):
// the agnostic SDK surface — the `@pi-innovations/beacon-sdk` root, which is the
// `createHttpBeacon` entry — must pull ZERO hono onto its runtime module graph.
//
// Mechanism: bundle the root entry with hono marked external. Every RUNTIME
// `import ... from 'hono'`/'hono/bun' on the graph survives bundling as a verbatim
// externalized import statement; `import type` is erased by the transpiler, so this
// captures exactly the runtime graph (which is what forces a consumer to install
// hono). A hono-free root produces no such statement. The Hono adapter lives behind
// the opt-in ./hono subpath and is intentionally NOT on this graph.

const ROOT_ENTRY = new URL('../index.ts', import.meta.url).pathname;
const HONO_IMPORT = /\bfrom\s*["']hono(\/[^"']*)?["']/;
const HONO_REQUIRE = /\brequire\(\s*["']hono(\/[^"']*)?["']\s*\)/;

describe('agnostic SDK import isolation', () => {
  test('the root @pi-innovations/beacon-sdk graph imports no hono at runtime', async () => {
    const built = await Bun.build({
      entrypoints: [ROOT_ENTRY],
      target: 'bun',
      external: ['hono', 'hono/bun'],
    });
    expect(built.success).toBe(true);

    const code = (await Promise.all(built.outputs.map((o) => o.text()))).join('\n');
    expect(code).not.toMatch(HONO_IMPORT);
    expect(code).not.toMatch(HONO_REQUIRE);
  });
});
