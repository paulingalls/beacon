import { expect, test } from '@playwright/test';
import { DASH, metric, widget } from './helpers';

test('renders all four widgets with the seeded data', async ({ page }) => {
  await page.goto(DASH);
  for (const [name, value] of [
    ['Events', '10'],
    ['Users', '4'],
    ['Visitors', '7'],
  ]) {
    await expect(metric(page, name)).toHaveText(value + name);
  }
  await expect(widget(page, 'Overview').locator('canvas')).toHaveCount(1);
  for (const path of ['/home', '/pricing']) {
    await expect(
      widget(page, 'Top Pages').getByRole('cell', { name: path, exact: true }),
    ).toBeVisible();
  }
  await expect(
    widget(page, 'Attribution').getByRole('row', { name: 'google 3 2 66.7%' }),
  ).toBeVisible();
  const funnel = widget(page, 'Funnel');
  await expect(funnel.getByText('Overall conversion: 42.9%', { exact: true })).toBeVisible();
  await expect(funnel.getByText('↓57.1%', { exact: true })).toBeVisible();
  await expect(funnel.getByText('7', { exact: true })).toBeVisible();
  await expect(funnel.getByText('3', { exact: true })).toBeVisible();
  await funnel.getByRole('combobox').nth(1).selectOption('');
  await expect(funnel.getByText('Select at least 2 steps to see the funnel.')).toBeVisible();
  await funnel.getByRole('combobox').nth(1).selectOption('signup');
  await expect(funnel.getByText('Overall conversion: 42.9%')).toBeVisible();
  await funnel.getByRole('combobox').nth(0).selectOption('signup');
  await funnel.getByRole('combobox').nth(1).selectOption('request');
  await expect(funnel.getByText('Overall conversion: 0.0%')).toBeVisible();
  await expect(funnel.getByText('3', { exact: true })).toBeVisible();
  await expect(funnel.getByText('0', { exact: true })).toBeVisible();
});

test('the product selector and attribution grouping re-fetch real results', async ({ page }) => {
  await page.goto(DASH);
  await expect(metric(page)).toHaveText('10Events');
  await page.getByLabel('Product').selectOption('clipcast');
  await expect(metric(page)).toHaveText('7Events');
  const attribution = widget(page, 'Attribution');
  await expect(attribution.getByRole('row', { name: 'google 3 2 66.7%' })).toBeVisible();
  await expect(attribution.getByRole('row', { name: 'twitter 2 0 0.0%' })).toBeVisible();
  await attribution.getByLabel('Group by').selectOption({ label: 'Medium' });
  await expect(attribution.getByRole('row', { name: 'search 3 2 66.7%' })).toBeVisible();
  await expect(attribution.getByRole('row', { name: 'social 2 0 0.0%' })).toBeVisible();
  await attribution.getByLabel('Group by').selectOption({ label: 'Campaign' });
  await expect(attribution.getByRole('row', { name: 'clipcast-launch 5 2 40.0%' })).toBeVisible();
  await page.getByLabel('Product').selectOption('lensflare');
  await expect(metric(page)).toHaveText('3Events');
  await expect(widget(page, 'Top Pages').getByRole('row', { name: '/dash 2 2' })).toBeVisible();
  await expect(attribution.getByRole('row', { name: 'lensflare-launch 2 1 50.0%' })).toBeVisible();
  await expect(attribution.getByText('clipcast-launch')).toHaveCount(0);
  await attribution.getByLabel('Group by').selectOption({ label: 'Source' });
  await expect(attribution.getByRole('row', { name: 'bing 2 1 50.0%' })).toBeVisible();
  await expect(attribution.getByText('google')).toHaveCount(0);
});

test('narrowing the date range to 7d shows empty states, not errors', async ({ page }) => {
  await page.goto(DASH);
  await expect(widget(page, 'Top Pages').getByText('/home')).toBeVisible();
  // The seed is ten days old.
  await page.getByRole('button', { name: '7d', exact: true }).click();
  for (const [name, text] of [
    ['Overview', /No data/],
    ['Top Pages', /No request events/],
    ['Attribution', /No attribution data/],
    ['Funnel', /No funnel data/],
  ] as const) {
    await expect(widget(page, name).getByText(text)).toBeVisible();
  }
  await expect(page.getByText(/Failed to load/)).toHaveCount(0);
});

test('a custom From/To date range re-fetches against that window', async ({ page }) => {
  await page.goto(DASH);
  await page.getByRole('button', { name: '7d', exact: true }).click();
  await expect(widget(page, 'Top Pages').getByText(/No request events/)).toBeVisible();
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  await page.getByLabel('From').fill(fmt(new Date(Date.now() - 15 * 86_400_000)));
  await page.getByLabel('To', { exact: true }).fill(fmt(new Date(Date.now() - 5 * 86_400_000)));
  await expect(metric(page)).toHaveText('10Events');
  await expect(widget(page, 'Top Pages').getByText('/home')).toBeVisible();
});

test('a non-admin caller is denied the dashboard with a 403', async ({ request }) => {
  const res = await request.get('http://127.0.0.1:3918/analytics/dashboard');
  expect(res.status()).toBe(403);
  expect((await res.json()).error.code).toBe('UNAUTHORIZED');
});
