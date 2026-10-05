import { expect, test } from '@playwright/test';
import { DASH, metric, widget } from './helpers';

test.beforeEach(async ({ page }) => {
  await page.route('https://cdn.jsdelivr.net/**', (route) => route.abort());
});

test('schema failure is visible and reload recovers the dashboard', async ({ page }) => {
  await page.route('**/schema', (route) => route.fulfill({ status: 503 }), { times: 1 });
  await page.goto(DASH);
  await expect(page.getByRole('alert')).toHaveText(/reload the page/);
  await page.reload();
  await expect(page.getByRole('alert')).toBeHidden();
  for (const [name, value] of [
    ['Events', '10'],
    ['Users', '4'],
    ['Visitors', '7'],
  ]) {
    await expect(metric(page, name)).toHaveText(value + name);
  }
  for (const [name, text] of [
    ['Top Pages', '/home'],
    ['Attribution', 'google'],
    ['Funnel', 'Overall conversion: 42.9%'],
  ]) {
    await expect(widget(page, name).getByText(text, { exact: true })).toBeVisible();
  }
});

for (const [name, endpoint] of [
  ['Overview', 'aggregate'],
  ['Top Pages', 'events'],
  ['Attribution', 'attribution'],
  ['Funnel', 'funnel'],
] as const) {
  test(`${name} failure preserves siblings and controls recover it`, async ({ page }) => {
    let fail = true;
    await page.route(`**/analytics/${endpoint}?*`, (route) =>
      fail ? route.fulfill({ status: 503 }) : route.continue(),
    );
    await page.goto(DASH);
    await expect(widget(page, name).getByText(/Failed to load/)).toBeVisible();
    if (name !== 'Overview') await expect(metric(page)).toHaveText('10Events');
    for (const [sibling, text] of [
      ['Top Pages', '/home'],
      ['Attribution', 'google'],
      ['Funnel', 'Overall conversion: 42.9%'],
    ]) {
      if (sibling !== name)
        await expect(widget(page, sibling).getByText(text, { exact: true })).toBeVisible();
    }
    fail = false;
    if (name === 'Attribution')
      await widget(page, name).getByLabel('Group by').selectOption({ label: 'Medium' });
    else if (name === 'Funnel')
      await widget(page, name).getByRole('combobox').nth(1).selectOption('request');
    else await page.getByLabel('Product').selectOption('clipcast');
    const recovered = {
      Overview: '7Events',
      'Top Pages': '/home',
      Attribution: 'search',
      Funnel: 'Overall conversion: 0.0%',
    }[name];
    await expect(
      name === 'Overview' ? metric(page) : widget(page, name).getByText(recovered, { exact: true }),
    ).toHaveText(recovered);
    await expect(widget(page, name).getByText(/Failed to load/)).toHaveCount(0);
  });
}

test('edge text is literal, prototype paths tally, and capped top pages disclose approximation', async ({
  page,
}) => {
  const payload = '<img src=x onerror=alert(1)> & "label"';
  const dialogs: string[] = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await page.route('**/schema', async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.event_types.push({ product_id: 'clipcast', event_type: payload });
    await route.fulfill({ response, json });
  });
  const events = Array.from({ length: 1200 }, (_, i) => ({
    properties: {
      path:
        i < 500 ? '__proto__' : i < 900 ? payload : i < 1000 ? `/page-${i % 20}` : '/outside-cap',
    },
    user_id: i >= 500 ? 'one-user' : null,
    visitor_token: i < 500 ? '__proto__' : null,
  }));
  await page.route('**/analytics/events?*', (route) => {
    const params = new URL(route.request().url()).searchParams;
    const start = Number(params.get('cursor')?.slice('offset-'.length) ?? 0);
    const end = Math.min(start + Number(params.get('limit')), events.length);
    return route.fulfill({
      json: {
        events: events.slice(start, end),
        cursor: end < events.length ? `offset-${end}` : null,
      },
    });
  });
  await page.route('**/analytics/attribution?*', (route) =>
    route.fulfill({
      json: { groups: [{ key: payload, clicks: 2, conversions: 0, conversion_rate: 0 }] },
    }),
  );
  await page.route('**/analytics/funnel?*', (route) => {
    const params = new URL(route.request().url()).searchParams;
    if (
      params.get('product_id') !== 'clipcast' ||
      params.get('steps') !== `request,${payload},${payload}`
    )
      return route.continue();
    return route.fulfill({
      json: {
        steps: ['request', payload, payload].map((event_type, i) => ({
          event_type,
          count: i === 0 ? 2 : 0,
          conversion_rate: i === 0 ? 1 : 0,
        })),
        overall_conversion: 0,
      },
    });
  });
  await page.goto(DASH);
  const top = widget(page, 'Top Pages');
  await expect(top.getByRole('row', { name: '__proto__ 500 1', exact: true })).toBeVisible();
  await expect(
    top
      .getByRole('row')
      .filter({ has: page.getByRole('cell', { name: payload, exact: true }) })
      .getByRole('cell'),
  ).toHaveText([payload, '400', '1']);
  const cells = top.locator('tbody tr');
  await expect(cells).toHaveCount(20);
  const views = await cells.evaluateAll((rows) =>
    rows.map((r) => Number(r.children[1].textContent)),
  );
  expect(views).toEqual([500, 400, ...Array(18).fill(5)]);
  await expect(top.getByText('/outside-cap')).toHaveCount(0);
  await expect(top.getByText(/Approximate.*most recent 1000 requests/)).toBeVisible();
  await expect(
    widget(page, 'Attribution').getByRole('cell', { name: payload, exact: true }),
  ).toBeVisible();
  await page.getByLabel('Product').selectOption('clipcast');
  const funnel = widget(page, 'Funnel');
  await expect(funnel.getByText('Overall conversion: 40.0%')).toBeVisible();
  await expect(
    funnel.getByRole('combobox').nth(1).locator('option', { hasText: payload }),
  ).toHaveText(payload);
  await funnel.getByRole('combobox').nth(1).selectOption(payload);
  await funnel.getByRole('combobox').nth(2).selectOption(payload);
  await expect(funnel.getByText(payload, { exact: true }).filter({ visible: true })).toHaveCount(2);
  await expect(funnel.getByText('Overall conversion: 0.0%')).toBeVisible();
  await expect(funnel.getByText('↓100.0%', { exact: true })).toHaveCount(1);
  await page.getByLabel('Product').selectOption('lensflare');
  await expect(funnel.getByText('Select at least 2 steps to see the funnel.')).toBeVisible();
  await expect(funnel.getByRole('combobox').nth(1)).toHaveValue('');
  await expect(
    funnel.getByRole('combobox').nth(1).locator('option', { hasText: payload }),
  ).toHaveCount(0);
  await funnel.getByRole('combobox').nth(1).selectOption('signup');
  await expect(funnel.getByText('Overall conversion: 50.0%')).toBeVisible();
  expect(dialogs).toEqual([]);
});

test.describe('local calendar at a custom mount', () => {
  test.use({ timezoneId: 'America/Los_Angeles' });
  test('single-day To is exclusive next-day midnight and Today starts locally', async ({
    page,
  }) => {
    await page.goto('http://127.0.0.1:3919/custom/analytics/dashboard');
    await expect(metric(page)).toHaveText('10Events');
    await page.getByLabel('Product').selectOption('calendar');
    await page.getByLabel('From').fill('2024-03-10');
    const bounds = page.waitForRequest(
      (r) =>
        r.url().includes('/aggregate?') &&
        new URL(r.url()).searchParams.get('before') === '2024-03-11T07:00:00.000Z',
    );
    await page.getByLabel('To', { exact: true }).fill('2024-03-10');
    expect(new URL((await bounds).url()).searchParams.get('after')).toBe(
      '2024-03-10T08:00:00.000Z',
    );
    await expect(metric(page)).toHaveText('2Events');
    await expect(
      widget(page, 'Top Pages').getByRole('row', { name: '/inside-day 2 2' }),
    ).toBeVisible();
    await expect(widget(page, 'Top Pages').getByText(/\/before-day|\/after-day/)).toHaveCount(0);
    await page.clock.setFixedTime(new Date('2024-03-10T12:00:00Z'));
    const today = page.waitForRequest(
      (r) =>
        r.url().includes('/aggregate?') &&
        new URL(r.url()).searchParams.get('before') === '2024-03-10T12:00:00.000Z',
    );
    await page.getByRole('button', { name: 'Today', exact: true }).click();
    expect(new URL((await today).url()).searchParams.get('after')).toBe('2024-03-10T08:00:00.000Z');
    await expect(metric(page)).toHaveText('1Events');
    await expect(
      widget(page, 'Top Pages').getByRole('row', { name: '/inside-day 1 1' }),
    ).toBeVisible();
  });
});

for (const control of ['filters', 'group', 'steps'] as const) {
  test(`late ${control} response cannot replace the latest selection`, async ({ page }) => {
    await page.goto(DASH);
    await expect(metric(page)).toHaveText('10Events');
    const attribution = widget(page, 'Attribution');
    const funnel = widget(page, 'Funnel');
    if (control !== 'filters') {
      await page.getByLabel('Product').selectOption('clipcast');
      await expect(attribution.getByRole('row', { name: 'google 3 2 66.7%' })).toBeVisible();
      await expect(funnel.getByText('Overall conversion: 40.0%')).toBeVisible();
    }
    const endpoint =
      control === 'filters' ? 'aggregate' : control === 'group' ? 'attribution' : 'funnel';
    let release!: () => void;
    let arrived!: () => void;
    const held = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const delivery = new Promise<void>((resolve) => {
      release = resolve;
    });
    let heldUrl = '';
    await page.route(`**/analytics/${endpoint}?*`, async (route) => {
      const params = new URL(route.request().url()).searchParams;
      const match =
        params.get('product_id') === 'clipcast' &&
        (control === 'filters'
          ? params.get('metric') === 'count' && !params.has('group_by')
          : control === 'group'
            ? params.get('group_by') === 'utm_medium'
            : params.get('steps') === 'request,request');
      if (!match || heldUrl) return route.continue();
      heldUrl = route.request().url();
      const response = await route.fetch();
      arrived();
      await delivery;
      await route.fulfill({ response });
    });
    try {
      if (control === 'filters') await page.getByLabel('Product').selectOption('clipcast');
      else if (control === 'group')
        await attribution.getByLabel('Group by').selectOption({ label: 'Medium' });
      else await funnel.getByRole('combobox').nth(1).selectOption('request');
      await held;
      if (control === 'steps') {
        await funnel.getByRole('combobox').nth(1).selectOption('');
        await expect(funnel.getByText('Select at least 2 steps to see the funnel.')).toBeVisible();
      } else {
        await page.getByLabel('Product').selectOption('lensflare');
        if (control === 'filters') {
          await page.getByRole('button', { name: '7d', exact: true }).click();
          await page.getByRole('button', { name: '30d', exact: true }).click();
        } else
          await expect(attribution.getByRole('row', { name: 'search 2 1 50.0%' })).toBeVisible();
      }
      const response = page.waitForResponse((r) => r.url() === heldUrl);
      release();
      await (await response).body();
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      if (control === 'steps') {
        await expect(funnel.getByText('Select at least 2 steps to see the funnel.')).toBeVisible();
        await funnel.getByRole('combobox').nth(1).selectOption('signup');
        await expect(funnel.getByText('Overall conversion: 40.0%')).toBeVisible();
        await expect(funnel.getByText('5', { exact: true })).toBeVisible();
        await expect(funnel.getByText('2', { exact: true })).toBeVisible();
      } else {
        await expect(page.getByLabel('Product')).toHaveValue('lensflare');
        await expect(metric(page)).toHaveText('3Events');
        await expect(
          widget(page, 'Top Pages').getByRole('row', { name: '/dash 2 2' }),
        ).toBeVisible();
        await expect(
          attribution.getByRole('row', {
            name: control === 'group' ? 'search 2 1 50.0%' : 'bing 2 1 50.0%',
          }),
        ).toBeVisible();
        await expect(
          attribution.getByText(control === 'group' ? 'social' : 'google', { exact: true }),
        ).toHaveCount(0);
        await expect(attribution.getByLabel('Group by')).toHaveValue(
          control === 'group' ? 'utm_medium' : 'utm_source',
        );
        await expect(funnel.getByText('Overall conversion: 50.0%')).toBeVisible();
        await expect(funnel.getByText('2', { exact: true })).toBeVisible();
        await expect(funnel.getByText('1', { exact: true })).toBeVisible();
      }
    } finally {
      release();
    }
  });
}
