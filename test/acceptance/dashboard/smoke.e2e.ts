import { expect, test } from '@playwright/test';

// Self-contained smoke proving the Playwright + Chromium harness runs (no server, no
// Postgres). The DB-backed dashboard acceptance lives in dashboard.e2e.ts, which boots
// the seeded app via the webServer in playwright.config.ts.
test('chromium renders and queries a trivial page', async ({ page }) => {
  await page.setContent('<main><h1 id="beacon">Beacon</h1></main>');
  await expect(page.locator('#beacon')).toHaveText('Beacon');
});
