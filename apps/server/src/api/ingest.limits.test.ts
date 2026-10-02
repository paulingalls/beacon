import { describe, expect, spyOn, test } from 'bun:test';
import type { BeaconEvent } from '@pi-innovations/beacon-sdk';
import { Hono } from 'hono';
import type { EventBuffer } from '../events/buffer';
import { createIngestHandler, type IngestOptions } from './ingest';

/** Recording stand-in for EventBuffer — the handler only calls push(). */
function recordingBuffer(): { buffer: EventBuffer; pushed: BeaconEvent[] } {
  const pushed: BeaconEvent[] = [];
  const buffer = { push: (e: BeaconEvent) => pushed.push(e) } as unknown as EventBuffer;
  return { buffer, pushed };
}

function appWith(buffer: EventBuffer, opts: IngestOptions): Hono {
  const app = new Hono();
  app.post('/events', createIngestHandler(buffer, opts));
  return app;
}

/** POST a JSON body (or raw string) to /events. */
async function post(
  app: Hono,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.request('/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** Parse a §5.5 error body. */
async function errBody(res: Response): Promise<{ code: string; parameter?: string }> {
  return ((await res.json()) as { error: { code: string; parameter?: string } }).error;
}

describe('createIngestHandler — fallback observability (concern 627bc47710fd)', () => {
  test('reports product_id_used and logs nothing on a valid body product_id', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const { buffer } = recordingBuffer();
    const res = await post(appWith(buffer, { productId: 'clipcast' }), {
      product_id: 'other-app',
      events: [{ event_type: 'a' }],
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 1, product_id_used: 'other-app' });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  test('reports the configured product_id_used and stays silent when product_id is absent', async () => {
    // Absent product_id is the normal web default-to-configured case — no log spam.
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const { buffer } = recordingBuffer();
    const res = await post(appWith(buffer, { productId: 'clipcast' }), {
      events: [{ event_type: 'a' }],
    });
    expect(await res.json()).toEqual({ accepted: 1, product_id_used: 'clipcast' });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  test('warns once with the rejected value and reports the fallback when a present product_id is invalid', async () => {
    for (const product_id of ['', '   ', 42, null, 'x'.repeat(101)] as unknown[]) {
      const warn = spyOn(console, 'warn').mockImplementation(() => {});
      const { buffer } = recordingBuffer();
      const res = await post(appWith(buffer, { productId: 'clipcast' }), {
        product_id,
        events: [{ event_type: 'a' }],
      });
      expect(res.status).toBe(202); // skip-not-reject preserved
      expect(await res.json()).toEqual({ accepted: 1, product_id_used: 'clipcast' });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain('invalid body.product_id');
      warn.mockRestore();
    }
  });
});

describe('createIngestHandler — product allowlist (strict mode, concerns 5cd718796d70/5966333732ba)', () => {
  const allowlist = ['clipcast', 'other-app'];

  test('honors an allowlisted body product_id (202, echoed, stored)', async () => {
    const { buffer, pushed } = recordingBuffer();
    const res = await post(
      appWith(buffer, { productId: 'clipcast', productAllowlist: allowlist }),
      {
        product_id: 'other-app',
        events: [{ event_type: 'a' }, { event_type: 'b' }],
      },
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 2, product_id_used: 'other-app' });
    expect(pushed.map((e) => e.productId)).toEqual(['other-app', 'other-app']);
  });

  test('rejects a present non-allowlisted product_id with 403, drops the batch, logs the count', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const { buffer, pushed } = recordingBuffer();
    const res = await post(
      appWith(buffer, { productId: 'clipcast', productAllowlist: allowlist }),
      {
        product_id: 'evil-app',
        events: [{ event_type: 'a' }, { event_type: 'b' }, { event_type: 'c' }],
      },
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('UNAUTHORIZED');
    expect(pushed).toHaveLength(0); // whole batch dropped
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('dropped 3 event(s)');
    warn.mockRestore();
  });

  test('rejects an invalid-shape product_id with 403 when an allowlist is set', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const { buffer, pushed } = recordingBuffer();
    const res = await post(
      appWith(buffer, { productId: 'clipcast', productAllowlist: allowlist }),
      {
        product_id: '',
        events: [{ event_type: 'a' }],
      },
    );
    expect(res.status).toBe(403);
    expect(pushed).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('dropped 1 event(s)');
    warn.mockRestore();
  });

  test('absent product_id defaults to the configured product (202, no reject, no warn)', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const { buffer, pushed } = recordingBuffer();
    const res = await post(
      appWith(buffer, { productId: 'clipcast', productAllowlist: allowlist }),
      {
        events: [{ event_type: 'a' }],
      },
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 1, product_id_used: 'clipcast' });
    expect(pushed[0]?.productId).toBe('clipcast');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('createIngestHandler — timestamps', () => {
  test('uses a valid client timestamp, defaults to ingest time otherwise, ignores received_at', async () => {
    const { buffer, pushed } = recordingBuffer();
    const app = appWith(buffer, { productId: 'p' });

    await post(app, {
      events: [
        { event_type: 'noTs' },
        { event_type: 'withTs', timestamp: '2026-04-04T10:30:00Z' },
        { event_type: 'badTs', timestamp: 'not-a-date' },
        { event_type: 'rcv', received_at: '2020-01-01T00:00:00Z' },
      ],
    });

    expect(pushed[0]?.timestamp).toBeUndefined(); // defaults to received_at at flush
    expect(pushed[1]?.timestamp).toEqual(new Date('2026-04-04T10:30:00Z'));
    expect(pushed[2]?.timestamp).toBeUndefined(); // unparseable → default
    expect(pushed[3]?.timestamp).toBeUndefined(); // client received_at is never read
  });
});

describe('createIngestHandler — rate limiting', () => {
  /** Build a limiter-controlled app with an injected clock and per-request ip header. */
  function rateLimitedApp(buffer: EventBuffer, now: () => number): Hono {
    return appWith(buffer, {
      productId: 'p',
      rateLimit: { limit: 10, windowMs: 60_000, now },
      getClientAddress: (c) => c.req.header('x-test-ip'),
    });
  }

  test('returns 429 with Retry-After once the per-identifier limit is exceeded', async () => {
    const { buffer } = recordingBuffer();
    const app = rateLimitedApp(buffer, () => 1000);

    for (let i = 0; i < 10; i++) {
      const ok = await post(app, { events: [{ event_type: 'e' }] }, { 'x-test-ip': 'a' });
      expect(ok.status).toBe(202);
    }
    const denied = await post(app, { events: [{ event_type: 'e' }] }, { 'x-test-ip': 'a' });
    expect(denied.status).toBe(429);
    expect(Number(denied.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect((await errBody(denied)).code).toBe('RATE_LIMITED');
  });

  test('isolates the limit per identifier', async () => {
    const { buffer } = recordingBuffer();
    const app = appWith(buffer, {
      productId: 'p',
      rateLimit: { limit: 1, windowMs: 60_000, now: () => 1000 },
      getClientAddress: (c) => c.req.header('x-test-ip'),
    });

    await post(app, { events: [{ event_type: 'e' }] }, { 'x-test-ip': 'a' });
    expect((await post(app, { events: [{ event_type: 'e' }] }, { 'x-test-ip': 'a' })).status).toBe(
      429,
    );
    expect((await post(app, { events: [{ event_type: 'e' }] }, { 'x-test-ip': 'b' })).status).toBe(
      202,
    );
  });

  test('keys the limit by authenticated user id when present', async () => {
    const { buffer } = recordingBuffer();
    // Same ip for both requests, but distinct users → independent buckets.
    const app = appWith(buffer, {
      productId: 'p',
      getUserId: (c) => c.req.header('x-test-user') ?? null,
      rateLimit: { limit: 1, windowMs: 60_000, now: () => 1000 },
      getClientAddress: () => 'shared-ip',
    });

    await post(app, { events: [{ event_type: 'e' }] }, { 'x-test-user': 'u1' });
    expect(
      (await post(app, { events: [{ event_type: 'e' }] }, { 'x-test-user': 'u1' })).status,
    ).toBe(429);
    expect(
      (await post(app, { events: [{ event_type: 'e' }] }, { 'x-test-user': 'u2' })).status,
    ).toBe(202);
  });
});
