import { describe, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';

import { Hono } from 'hono';
import type { EventBuffer } from '../events/buffer';
import type { BeaconEvent } from '../types';
import { createIngestHandler, type IngestOptions } from './ingest';

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

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

describe('createIngestHandler — valid batches', () => {
  test('accepts a batch and pushes each event with inferred product_id + platform', async () => {
    const { buffer, pushed } = recordingBuffer();
    const app = appWith(buffer, { productId: 'clipcast' });

    const res = await post(
      app,
      {
        events: [
          { event_type: 'a', properties: { x: 1 } },
          { event_type: 'b' },
          { event_type: 'c' },
        ],
      },
      { 'x-app-context': JSON.stringify({ platform: 'ios' }) },
    );

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 3, product_id_used: 'clipcast' });
    expect(pushed).toHaveLength(3);
    expect(pushed[0]?.productId).toBe('clipcast');
    expect(pushed[0]?.eventType).toBe('a');
    expect(pushed[0]?.properties).toEqual({ x: 1 });
    expect(pushed[0]?.platform).toBe('ios');
    expect(pushed[1]?.properties).toEqual({}); // omitted properties default to {}
  });

  test('infers user_id and visitor_token, and carries transport context', async () => {
    const { buffer, pushed } = recordingBuffer();
    const app = new Hono();
    app.use('/events', async (c, next) => {
      c.set('beaconVisitorToken', 'tok123456789');
      await next();
    });
    app.post(
      '/events',
      createIngestHandler(buffer, {
        productId: 'p',
        getUserId: () => 'user-7',
        hashIPs: false,
        getClientAddress: () => '192.0.2.1',
      }),
    );

    await app.request('/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'SDK/1.0' },
      body: JSON.stringify({ events: [{ event_type: 'screen_view' }] }),
    });

    expect(pushed[0]?.userId).toBe('user-7');
    expect(pushed[0]?.visitorToken).toBe('tok123456789');
    expect(pushed[0]?.context).toMatchObject({ user_agent: 'SDK/1.0', ip: '192.0.2.1' });
  });
});

describe('createIngestHandler — envelope validation', () => {
  test('rejects a batch over 100 events with 400 and pushes nothing', async () => {
    const { buffer, pushed } = recordingBuffer();
    const app = appWith(buffer, { productId: 'p' });

    const events = Array.from({ length: 101 }, (_, i) => ({ event_type: `e${i}` }));
    const res = await post(app, { events });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; parameter?: string } };
    expect(body.error.code).toBe('INVALID_PARAMETER');
    expect(body.error.parameter).toBe('events');
    expect(pushed).toHaveLength(0);
  });

  test('missing events key → 400 MISSING_PARAMETER', async () => {
    const { buffer } = recordingBuffer();
    const res = await post(appWith(buffer, { productId: 'p' }), { notEvents: [] });
    expect(res.status).toBe(400);
    expect((await errBody(res)).code).toBe('MISSING_PARAMETER');
  });

  test('non-array events → 400 INVALID_PARAMETER', async () => {
    const { buffer } = recordingBuffer();
    const res = await post(appWith(buffer, { productId: 'p' }), { events: 'nope' });
    expect(res.status).toBe(400);
    expect((await errBody(res)).code).toBe('INVALID_PARAMETER');
  });

  test('malformed JSON body → 400 INVALID_PARAMETER', async () => {
    const { buffer, pushed } = recordingBuffer();
    const res = await post(appWith(buffer, { productId: 'p' }), '{bad json');
    expect(res.status).toBe(400);
    expect((await errBody(res)).code).toBe('INVALID_PARAMETER');
    expect(pushed).toHaveLength(0);
  });
});

describe('createIngestHandler — per-event skip (not reject)', () => {
  test('skips invalid events; accepted counts only valid ones', async () => {
    const { buffer, pushed } = recordingBuffer();
    const app = appWith(buffer, { productId: 'p' });
    const oversized = { blob: 'x'.repeat(11 * 1024) }; // > 10KB serialized

    const res = await post(app, {
      events: [
        { event_type: 'good', properties: { ok: 1 } },
        { properties: { y: 1 } }, // missing event_type
        { event_type: '   ' }, // whitespace-only
        { event_type: 'x'.repeat(101) }, // too long
        { event_type: 42 }, // non-string
        { event_type: 'big', properties: oversized }, // oversized properties
        { event_type: 'badprops', properties: 'not-an-object' }, // properties not an object
      ],
    });

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 1, product_id_used: 'p' });
    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.eventType).toBe('good');
  });

  test('trims surrounding whitespace from event_type before storing', async () => {
    const { buffer, pushed } = recordingBuffer();
    await post(appWith(buffer, { productId: 'p' }), { events: [{ event_type: '  signup  ' }] });
    expect(pushed[0]?.eventType).toBe('signup');
  });
});

describe('createIngestHandler — batch product_id', () => {
  test('honors a valid body product_id over the configured one', async () => {
    const { buffer, pushed } = recordingBuffer();
    const app = appWith(buffer, { productId: 'clipcast' });

    const res = await post(app, {
      product_id: 'other-app',
      events: [{ event_type: 'a' }, { event_type: 'b' }],
    });

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 2, product_id_used: 'other-app' });
    expect(pushed.map((e) => e.productId)).toEqual(['other-app', 'other-app']);
  });

  test('falls back to the configured productId when the body has no product_id', async () => {
    const { buffer, pushed } = recordingBuffer();
    await post(appWith(buffer, { productId: 'clipcast' }), { events: [{ event_type: 'a' }] });
    expect(pushed[0]?.productId).toBe('clipcast');
  });

  test('falls back on an invalid product_id and still accepts the batch (skip-not-reject)', async () => {
    const invalid: unknown[] = ['', '   ', 42, null, { nested: true }, 'x'.repeat(101)];
    for (const product_id of invalid) {
      const { buffer, pushed } = recordingBuffer();
      const res = await post(appWith(buffer, { productId: 'clipcast' }), {
        product_id,
        events: [{ event_type: 'a' }],
      });
      expect(res.status).toBe(202);
      expect(pushed[0]?.productId).toBe('clipcast');
    }
  });

  test('trims surrounding whitespace from a valid body product_id', async () => {
    const { buffer, pushed } = recordingBuffer();
    await post(appWith(buffer, { productId: 'clipcast' }), {
      product_id: '  other-app  ',
      events: [{ event_type: 'a' }],
    });
    expect(pushed[0]?.productId).toBe('other-app');
  });

  test('rate-limit gate still fires before the body (and its product_id) is parsed', async () => {
    const { buffer, pushed } = recordingBuffer();
    const app = appWith(buffer, {
      productId: 'clipcast',
      rateLimit: { limit: 1, windowMs: 60_000, now: () => 1000 },
      getClientAddress: () => 'gate-ip',
    });

    expect(
      (await post(app, { product_id: 'other-app', events: [{ event_type: 'e' }] })).status,
    ).toBe(202);
    // Over the limit with a MALFORMED body: a 429 (not 400 INVALID_PARAMETER)
    // proves the gate rejected before any body/product_id parsing happened.
    const denied = await post(app, '{"product_id": "other-app", malformed');
    expect(denied.status).toBe(429);
    expect(pushed).toHaveLength(1);
  });
});

describe('createIngestHandler — batch visitor_token (body-carried, story-001)', () => {
  /** Mount the ingest handler behind middleware that seeds a transport beaconVisitorToken. */
  function appWithTransportToken(
    buffer: EventBuffer,
    opts: IngestOptions,
    transportToken: string,
  ): Hono {
    const app = new Hono();
    app.use('/events', async (c, next) => {
      c.set('beaconVisitorToken', transportToken);
      await next();
    });
    app.post('/events', createIngestHandler(buffer, opts));
    return app;
  }

  test('reads an anonymous visitor_token from the body when no transport token is present', async () => {
    const { buffer, pushed } = recordingBuffer();
    const app = appWith(buffer, { productId: 'p' });

    const res = await post(app, {
      visitor_token: 'v1',
      events: [{ event_type: 'a' }, { event_type: 'b' }],
    });

    expect(res.status).toBe(202);
    expect(pushed.map((e) => e.visitorToken)).toEqual(['v1', 'v1']);
  });

  test('body visitor_token wins over the transport token', async () => {
    const { buffer, pushed } = recordingBuffer();
    const app = appWithTransportToken(buffer, { productId: 'p' }, 't1');

    await post(app, { visitor_token: 'v1', events: [{ event_type: 'a' }] });

    expect(pushed[0]?.visitorToken).toBe('v1');
  });

  test('falls back to the transport token when the body omits visitor_token', async () => {
    const { buffer, pushed } = recordingBuffer();
    const app = appWithTransportToken(buffer, { productId: 'p' }, 't1');

    await post(app, { events: [{ event_type: 'a' }] });

    expect(pushed[0]?.visitorToken).toBe('t1');
  });

  test('falls back to the transport token on an invalid body visitor_token (skip-not-reject)', async () => {
    const invalid: unknown[] = ['', '   ', 42, null, { nested: true }, 'x'.repeat(101)];
    for (const visitor_token of invalid) {
      const { buffer, pushed } = recordingBuffer();
      const app = appWithTransportToken(buffer, { productId: 'p' }, 't1');

      const res = await post(app, { visitor_token, events: [{ event_type: 'a' }] });

      expect(res.status).toBe(202); // batch still accepted
      expect(pushed[0]?.visitorToken).toBe('t1');
    }
  });

  test('trims surrounding whitespace from a valid body visitor_token', async () => {
    const { buffer, pushed } = recordingBuffer();
    await post(appWith(buffer, { productId: 'p' }), {
      visitor_token: '  v1  ',
      events: [{ event_type: 'a' }],
    });
    expect(pushed[0]?.visitorToken).toBe('v1');
  });

  test('with neither body nor transport token, visitorToken is null', async () => {
    const { buffer, pushed } = recordingBuffer();
    await post(appWith(buffer, { productId: 'p' }), { events: [{ event_type: 'a' }] });
    expect(pushed[0]?.visitorToken).toBeNull();
  });

  test('ignores a body-asserted user_id — anonymous-only until trusted auth (M2)', async () => {
    const { buffer, pushed } = recordingBuffer();
    // getUserId resolves the real authenticated identity; the body must not override it.
    const app = appWith(buffer, { productId: 'p', getUserId: () => 'real-user' });

    await post(app, {
      visitor_token: 'v1',
      user_id: 'spoofed-user',
      events: [{ event_type: 'a' }],
    });

    expect(pushed[0]?.userId).toBe('real-user');
    expect(pushed[0]?.visitorToken).toBe('v1');
  });

  test('a body user_id is ignored even when no auth is configured (stays null)', async () => {
    const { buffer, pushed } = recordingBuffer();
    await post(appWith(buffer, { productId: 'p' }), {
      user_id: 'spoofed-user',
      events: [{ event_type: 'a' }],
    });
    expect(pushed[0]?.userId).toBeNull();
  });
});

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

describe('createIngestHandler — trusted bearer identity (M2)', () => {
  const TRUSTED = 'trusted-ingest-secret';
  // hashIPs:false isolates the per-event context assertions from IP hashing; a
  // dedicated test below covers that body.ip IS hashed when hashIPs is on.
  const trustedOpts: IngestOptions = {
    productId: 'p',
    trustedIngestToken: TRUSTED,
    hashIPs: false,
  };
  const auth = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

  test('honors distinct per-event user_id under a valid bearer (multi-user relay batch)', async () => {
    const { buffer, pushed } = recordingBuffer();
    await post(
      appWith(buffer, trustedOpts),
      {
        events: [
          { event_type: 'a', user_id: 'user-1' },
          { event_type: 'b', user_id: 'user-2' },
          { event_type: 'c' }, // no per-event user_id → transport fallback (null here)
        ],
      },
      auth(TRUSTED),
    );
    expect(pushed.map((e) => e.userId)).toEqual(['user-1', 'user-2', null]);
  });

  test('per-event user_id falls back to the transport user when omitted', async () => {
    const { buffer, pushed } = recordingBuffer();
    const app = appWith(buffer, { ...trustedOpts, getUserId: () => 'transport-user' });
    await post(
      app,
      { events: [{ event_type: 'a' }, { event_type: 'b', user_id: 'override' }] },
      auth(TRUSTED),
    );
    expect(pushed.map((e) => e.userId)).toEqual(['transport-user', 'override']);
  });

  test('replaces the event context with the body context (no relay/transport keys leak)', async () => {
    const { buffer, pushed } = recordingBuffer();
    const app = appWith(buffer, trustedOpts);
    await post(
      app,
      {
        events: [
          {
            event_type: 'a',
            user_id: 'u1',
            context: { ip: '198.51.100.9', user_agent: 'real-client', referrer: 'https://ref' },
          },
        ],
      },
      // Relay's own transport headers — must NOT appear on the user's event.
      { ...auth(TRUSTED), 'user-agent': 'relay-agent', referer: 'https://relay' },
    );
    expect(pushed[0]?.context).toEqual({
      ip: '198.51.100.9', // hashIPs:false → passed through
      user_agent: 'real-client',
      referrer: 'https://ref',
    });
  });

  test('hashes a body-provided ip under trust when hashIPs is on (never stores raw)', async () => {
    const { buffer, pushed } = recordingBuffer();
    const app = appWith(buffer, { productId: 'p', trustedIngestToken: TRUSTED, hashIPs: true });
    await post(
      app,
      { events: [{ event_type: 'a', user_id: 'u1', context: { ip: '198.51.100.9' } }] },
      auth(TRUSTED),
    );
    const ctx = pushed[0]?.context as { ip?: string };
    expect(ctx.ip).toBe(sha256('198.51.100.9'));
    expect(ctx.ip).not.toContain('198.51.100.9');
  });

  test('with no per-event context, the event keeps the transport context', async () => {
    const { buffer, pushed } = recordingBuffer();
    const app = appWith(buffer, trustedOpts);
    await post(
      app,
      { events: [{ event_type: 'a', user_id: 'u1' }] },
      { ...auth(TRUSTED), 'user-agent': 'relay-agent' },
    );
    expect((pushed[0]?.context as { user_agent?: string }).user_agent).toBe('relay-agent');
  });

  test('an over-length per-event user_id is trimmed/ignored, falling back to transport', async () => {
    // Documents the validShortString contract for body user_id (assumption d673e2a67d20):
    // >100 chars is treated as absent (silent fallback), and surrounding whitespace is trimmed.
    const { buffer, pushed } = recordingBuffer();
    const app = appWith(buffer, { ...trustedOpts, getUserId: () => 'transport-user' });
    await post(
      app,
      {
        events: [
          { event_type: 'long', user_id: 'x'.repeat(101) },
          { event_type: 'pad', user_id: '  u2  ' },
        ],
      },
      auth(TRUSTED),
    );
    expect(pushed[0]?.userId).toBe('transport-user'); // over-length → fallback
    expect(pushed[1]?.userId).toBe('u2'); // trimmed
  });

  test('an UNtrusted caller (no Authorization) never honors body user_id or context', async () => {
    const { buffer, pushed } = recordingBuffer();
    const app = appWith(buffer, { ...trustedOpts, getUserId: () => 'real-user' });
    await post(app, {
      events: [
        { event_type: 'a', user_id: 'spoofed', context: { ip: 'evil', user_agent: 'spoof' } },
      ],
    });
    expect(pushed[0]?.userId).toBe('real-user');
    expect((pushed[0]?.context as { user_agent?: string }).user_agent).toBeUndefined();
  });

  test('a wrong bearer is rejected — body identity ignored', async () => {
    const { buffer, pushed } = recordingBuffer();
    const app = appWith(buffer, { ...trustedOpts, getUserId: () => 'real-user' });
    await post(app, { events: [{ event_type: 'a', user_id: 'spoofed' }] }, auth('wrong-secret'));
    expect(pushed[0]?.userId).toBe('real-user');
  });

  test('with no trustedIngestToken configured, a valid-looking bearer is ignored (fail-closed)', async () => {
    const { buffer, pushed } = recordingBuffer();
    const app = appWith(buffer, { productId: 'p', getUserId: () => 'real-user' }); // no trust configured
    await post(app, { events: [{ event_type: 'a', user_id: 'spoofed' }] }, auth(TRUSTED));
    expect(pushed[0]?.userId).toBe('real-user');
  });

  test('never logs the bearer token', async () => {
    const log = spyOn(console, 'log');
    const warn = spyOn(console, 'warn');
    const error = spyOn(console, 'error');
    try {
      const { buffer } = recordingBuffer();
      await post(
        appWith(buffer, trustedOpts),
        { events: [{ event_type: 'a', user_id: 'u1' }] },
        auth(TRUSTED),
      );
      for (const spy of [log, warn, error]) {
        for (const call of spy.mock.calls) {
          expect(JSON.stringify(call)).not.toContain(TRUSTED);
        }
      }
    } finally {
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
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
