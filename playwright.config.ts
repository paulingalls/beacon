import { defineConfig, devices } from '@playwright/test';

// Playwright harness for the dashboard browser-UI acceptance surface (story-006,
// concern 1d36a7e08bee). The bun:test http_websocket harness asserts only the
// dashboard HTML string; these specs drive a real browser against the mounted app.
//
// Runner isolation: specs use the `*.e2e.ts` suffix (NOT `*.test.ts` / `*.spec.ts`),
// so `bun test` — which globs the latter — never executes them, and Playwright's
// testMatch below claims exactly this set. The two runners stay disjoint without any
// bunfig ignore patterns.
//
// serve.ts bootstraps Postgres, seeds a known fixture, and serves the mounted admin app on
// ADMIN_PORT (+ a non-admin app on DENY_PORT for the 403 case). It runs under Bun; Playwright
// waits for the dashboard route to answer before the specs run. The self-contained smoke spec
// needs no server but coexists under the same webServer.
const ADMIN_PORT = 3917;
const DENY_PORT = 3918;

export default defineConfig({
  testDir: './test/acceptance/dashboard',
  testMatch: '**/*.e2e.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'bun test/acceptance/dashboard/serve.ts',
    url: `http://127.0.0.1:${ADMIN_PORT}/analytics/dashboard`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { ADMIN_PORT: String(ADMIN_PORT), DENY_PORT: String(DENY_PORT) },
  },
});
