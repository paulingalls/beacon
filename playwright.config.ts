import { defineConfig, devices } from '@playwright/test';

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
