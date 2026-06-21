import { describe, expect, spyOn, test } from 'bun:test';

import { Hono } from 'hono';

import { type AdminGateOptions, adminGate, verifyTrustedBearer } from './auth';

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

describe('verifyTrustedBearer', () => {
  const TOKEN = 'trusted-secret-abc123';

  test('a Bearer header with the exact token matches (true)', () => {
    expect(verifyTrustedBearer(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
  });

  test('a wrong token of the SAME length is rejected (false)', () => {
    const wrong = 'trusted-secret-xyz789';
    expect(wrong.length).toBe(TOKEN.length); // same length isolates content, not length
    expect(verifyTrustedBearer(`Bearer ${wrong}`, TOKEN)).toBe(false);
  });

  test('a wrong token of a DIFFERENT length is rejected without throwing (false)', () => {
    // timingSafeEqual throws on unequal-length buffers; the SHA-256 step equalizes
    // length so a length mismatch is a plain false, never a thrown RangeError.
    expect(verifyTrustedBearer('Bearer short', TOKEN)).toBe(false);
    expect(verifyTrustedBearer(`Bearer ${TOKEN}-and-then-some-extra`, TOKEN)).toBe(false);
  });

  test('an absent Authorization header is rejected (false)', () => {
    expect(verifyTrustedBearer(undefined, TOKEN)).toBe(false);
    expect(verifyTrustedBearer(null, TOKEN)).toBe(false);
    expect(verifyTrustedBearer('', TOKEN)).toBe(false);
  });

  test('a non-Bearer scheme is rejected (false)', () => {
    expect(verifyTrustedBearer(`Basic ${TOKEN}`, TOKEN)).toBe(false);
    expect(verifyTrustedBearer(TOKEN, TOKEN)).toBe(false); // bare token, no scheme
  });

  test('with no trusted token configured, any header is rejected — fail-closed', () => {
    expect(verifyTrustedBearer(`Bearer ${TOKEN}`, undefined)).toBe(false);
    expect(verifyTrustedBearer(`Bearer ${TOKEN}`, '')).toBe(false);
  });

  test('never logs the token value (no console output at all)', () => {
    const logSpy = spyOn(console, 'log');
    const warnSpy = spyOn(console, 'warn');
    const errorSpy = spyOn(console, 'error');
    try {
      verifyTrustedBearer(`Bearer ${TOKEN}`, TOKEN);
      verifyTrustedBearer(`Bearer ${TOKEN}`, 'mismatch');
      verifyTrustedBearer(`Bearer ${TOKEN}`, undefined);
      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
