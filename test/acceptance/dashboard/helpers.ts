import type { Page } from '@playwright/test';

export const DASH = 'http://127.0.0.1:3917/analytics/dashboard';
export const widget = (page: Page, name: string) =>
  page.locator('section').filter({ has: page.getByRole('heading', { name, exact: true }) });
export const metric = (page: Page, name = 'Events') =>
  widget(page, 'Overview').getByText(name, { exact: true }).locator('..');
