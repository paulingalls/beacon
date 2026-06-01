import { describe, expect, test } from 'bun:test';

import { Hono } from 'hono';

import { type AdminGateOptions, adminGate } from './auth';

/** Mount adminGate ahead of a trailing 200 handler, mirroring ingest.test.ts's appWith. */
function appWith(opts: AdminGateOptions): Hono {
  const app = new Hono();
  app.use('/guarded', adminGate(opts));
  app.get('/guarded', (c) => c.text('ok'));
  return app;
}

/** Parse a §5.5 error body's inner `error` object. */
async function errBody(res: Response): Promise<{ code: string; message: string }> {
  return ((await res.json()) as { error: { code: string; message: string } }).error;
}

describe('adminGate', () => {
  test('admin reaches the handler (200)', async () => {
    const app = appWith({ isAdmin: () => true });
    const res = await app.request('/guarded');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  test('non-admin is rejected with a §5.5 UNAUTHORIZED 403', async () => {
    const app = appWith({ isAdmin: () => false });
    const res = await app.request('/guarded');
    expect(res.status).toBe(403);
    expect((await errBody(res)).code).toBe('UNAUTHORIZED');
  });

  test('a missing isAdmin callback is treated as non-admin (403)', async () => {
    const app = appWith({});
    const res = await app.request('/guarded');
    expect(res.status).toBe(403);
    expect((await errBody(res)).code).toBe('UNAUTHORIZED');
  });

  test('a throwing isAdmin is failure-isolated to a 403, not a 500 (§1.3)', async () => {
    const app = appWith({
      isAdmin: () => {
        throw new Error('auth boom');
      },
    });
    const res = await app.request('/guarded');
    expect(res.status).toBe(403);
    expect((await errBody(res)).code).toBe('UNAUTHORIZED');
  });

  test('the guard does not call the downstream handler when rejecting', async () => {
    let reached = false;
    const app = new Hono();
    app.use('/guarded', adminGate({ isAdmin: () => false }));
    app.get('/guarded', (c) => {
      reached = true;
      return c.text('ok');
    });
    await app.request('/guarded');
    expect(reached).toBe(false);
  });
});
