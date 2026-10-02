import { describe, expect, test } from 'bun:test';
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
