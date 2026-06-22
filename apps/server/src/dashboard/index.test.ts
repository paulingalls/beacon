import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { adminGate } from '../api/auth';
import { createDashboardHandler } from './index';

// The dashboard route handler (REQUIREMENTS.md §9.3). createDashboardHandler is the
// handler factory mirroring the query create*Handler convention; the admin gate is
// applied at mount time (story-001 step 4), so here we mount adminGate ahead of it —
// mirroring auth.test.ts — to prove the end-to-end 403/200 behaviour. No DB, no
// browser: real rendered behaviour is story-006's Playwright capstone.

/** Mount adminGate ahead of the dashboard handler, isAdmin driven by a test header. */
function appWith(): Hono {
  const app = new Hono();
  const isAdmin = (c: { req: { header: (k: string) => string | undefined } }) =>
    c.req.header('x-test-admin') === '1';
  app.use('/analytics/dashboard', adminGate({ isAdmin }));
  app.get('/analytics/dashboard', createDashboardHandler({ basePath: '/analytics' }));
  return app;
}

describe('dashboard route', () => {
  test('an admin gets a 200 text/html dashboard page', async () => {
    const res = await appWith().request('/analytics/dashboard', {
      headers: { 'x-test-admin': '1' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('<!DOCTYPE html>');
    expect(body).toContain('id="beacon-widget-overview"');
  });

  test('a non-admin gets a §5.5 403 with no HTML body', async () => {
    const res = await appWith().request('/analytics/dashboard'); // no admin header
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.text()).not.toContain('<!DOCTYPE html>');
  });

  test('renders the shell for the configured basePath', async () => {
    const app = new Hono();
    app.get('/d', createDashboardHandler({ basePath: '/custom/analytics' }));
    const res = await app.request('/d');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('data-base-path="/custom/analytics"');
  });
});
