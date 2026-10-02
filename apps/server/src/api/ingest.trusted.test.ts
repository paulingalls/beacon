import { describe, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { BeaconEvent } from '@pi-innovations/beacon-sdk';
import { Hono } from 'hono';
import type { EventBuffer } from '../events/buffer';
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

  test('honors distinct per-event visitor_token under a valid bearer (multi-visitor relay batch)', async () => {
    // The relay (HttpSink) drains events from many anonymous visitors into one batch; under trust
    // each event asserts its own visitor_token, so a single POST no longer needs per-token fan-out.
    const { buffer, pushed } = recordingBuffer();
    await post(
      appWith(buffer, trustedOpts),
      {
        events: [
          { event_type: 'a', visitor_token: 'v1' },
          { event_type: 'b', visitor_token: 'v2' },
          { event_type: 'c', visitor_token: 'v1' },
        ],
      },
      auth(TRUSTED),
    );
    expect(pushed.map((e) => e.visitorToken)).toEqual(['v1', 'v2', 'v1']);
  });

  test('per-event visitor_token falls back to the envelope token when omitted or invalid', async () => {
    const { buffer, pushed } = recordingBuffer();
    await post(
      appWith(buffer, trustedOpts),
      {
        visitor_token: 'env-v', // envelope/shared default
        events: [
          { event_type: 'a', visitor_token: 'pe-v' }, // per-event wins
          { event_type: 'b' }, // omitted → envelope
          { event_type: 'c', visitor_token: 'x'.repeat(101) }, // over-length → envelope (skip-not-reject)
        ],
      },
      auth(TRUSTED),
    );
    expect(pushed.map((e) => e.visitorToken)).toEqual(['pe-v', 'env-v', 'env-v']);
  });

  test('an UNtrusted caller never honors a per-event visitor_token (envelope token wins)', async () => {
    const { buffer, pushed } = recordingBuffer();
    await post(appWith(buffer, { productId: 'p' }), {
      visitor_token: 'env-v',
      events: [{ event_type: 'a', visitor_token: 'spoof' }],
    });
    expect(pushed[0]?.visitorToken).toBe('env-v');
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
