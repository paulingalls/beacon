import { expect, test } from '@playwright/test';

// Browser-UI acceptance for the admin dashboard (story-006, closes concern 1d36a7e08bee):
// the bun:test http_websocket harness asserts only the rendered HTML string — these specs
// drive a real Chromium against the seeded, mounted app (see serve.ts) and prove the inline
// JS actually fetches the query API and renders every widget, switches on the filters, and
// degrades to empty states. Ports match playwright.config.ts's webServer.
const ADMIN = 'http://127.0.0.1:3917';
const DENY = 'http://127.0.0.1:3918';
const DASH = '/analytics/dashboard';

/** The Events metric value in the Overview widget — scoped so the number is unambiguous. */
function eventsCard(page: import('@playwright/test').Page) {
  return page
    .locator('#beacon-widget-overview .beacon-metric')
    .filter({ hasText: 'Events' })
    .locator('.beacon-metric-value');
}

test('renders all four widgets with the seeded data', async ({ page }) => {
  await page.goto(ADMIN + DASH);

  // Overview: the three §5.4 metric cards reflect the all-products seed (10 events, 4 users,
  // 7 visitors), and the daily-volume canvas is in the DOM (Chart.js draw rides the CDN and
  // is best-effort — we assert the element, not pixels).
  const overview = page.locator('#beacon-widget-overview');
  await expect(eventsCard(page)).toHaveText('10');
  await expect(
    overview.locator('.beacon-metric').filter({ hasText: 'Users' }).locator('.beacon-metric-value'),
  ).toHaveText('4');
  await expect(
    overview
      .locator('.beacon-metric')
      .filter({ hasText: 'Visitors' })
      .locator('.beacon-metric-value'),
  ).toHaveText('7');
  await expect(overview.locator('canvas')).toHaveCount(1);

  // Top Pages: a real /events tally renders the seeded paths.
  const top = page.locator('#beacon-widget-top-pages');
  await expect(top.getByText('/home')).toBeVisible();
  await expect(top.getByText('/pricing')).toBeVisible();

  // Attribution: the seeded utm_source groups render.
  const attribution = page.locator('#beacon-widget-attribution');
  await expect(attribution.getByText('google')).toBeVisible();
  await expect(attribution.getByText('twitter')).toBeVisible();

  // Funnel: the default request→signup funnel draws its bars.
  await expect(page.locator('#beacon-widget-funnel .beacon-funnel-bar').first()).toBeVisible();
});

test('the product selector re-fetches every widget', async ({ page }) => {
  await page.goto(ADMIN + DASH);
  await expect(eventsCard(page)).toHaveText('10'); // all products

  await page.selectOption('#beacon-product-select', 'clipcast');
  await expect(eventsCard(page)).toHaveText('7'); // re-fetched, scoped to clipcast
  await expect(page.locator('#beacon-widget-attribution').getByText('google')).toBeVisible();

  await page.selectOption('#beacon-product-select', 'lensflare');
  await expect(eventsCard(page)).toHaveText('3'); // re-fetched again
  await expect(page.locator('#beacon-widget-top-pages').getByText('/dash')).toBeVisible();
  await expect(page.locator('#beacon-widget-attribution').getByText('bing')).toBeVisible();
  await expect(page.locator('#beacon-widget-attribution').getByText('google')).toHaveCount(0);
});

test('narrowing the date range to 7d shows empty states, not errors', async ({ page }) => {
  await page.goto(ADMIN + DASH);
  await expect(page.locator('#beacon-widget-top-pages').getByText('/home')).toBeVisible();

  // The seed is ~10 days old, so the 7d preset window holds no events.
  await page.getByRole('button', { name: '7d', exact: true }).click();

  await expect(page.locator('#beacon-widget-overview').getByText(/No data/i)).toBeVisible();
  await expect(
    page.locator('#beacon-widget-top-pages').getByText(/No request events/i),
  ).toBeVisible();
  await expect(
    page.locator('#beacon-widget-attribution').getByText(/No attribution data/i),
  ).toBeVisible();
  // None of the widgets fell into their error state.
  await expect(page.locator('.beacon-error')).toHaveCount(0);
});

test('a custom From/To date range re-fetches against that window', async ({ page }) => {
  await page.goto(ADMIN + DASH);
  // Start from the empty 7d window (seed is ~10 days old) to prove the re-fetch flips state.
  await page.getByRole('button', { name: '7d', exact: true }).click();
  await expect(
    page.locator('#beacon-widget-top-pages').getByText(/No request events/i),
  ).toBeVisible();

  // A custom range that comfortably brackets the ~10-day-old seed (15d→5d ago) — wide enough
  // that the exact time-of-day can't shift the seed out of the window near a midnight run.
  // This exercises the bootstrap's localDayIso custom-range path (both From and To inputs).
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  await page.fill('#beacon-range-after', fmt(new Date(Date.now() - 15 * 86_400_000)));
  await page.fill('#beacon-range-before', fmt(new Date(Date.now() - 5 * 86_400_000)));

  await expect(eventsCard(page)).toHaveText('10');
  await expect(page.locator('#beacon-widget-top-pages').getByText('/home')).toBeVisible();
});

test('a non-admin caller is denied the dashboard with a 403', async ({ request }) => {
  const res = await request.get(DENY + DASH);
  expect(res.status()).toBe(403);
  const body = (await res.json()) as { error: { code: string } };
  expect(body.error.code).toBe('UNAUTHORIZED');
});
