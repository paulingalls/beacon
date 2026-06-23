import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import type { BeaconEvent, EventSink } from '@pi-innovations/beacon-sdk';
import { honoRequest, track } from '@pi-innovations/beacon-sdk/hono';
import { Hono } from 'hono';

// story-002 CAPSTONE (Milestone 1): the PUBLISHED @pi-innovations/beacon-sdk/hono subpath consumed
// by a real Hono app on Bun.serve, against a GENUINE Hono Context. The agnostic-root round-trip is
// already proven by bunServeHttpWriter.roundtrip; the zero-hono root by honoIsolation; the export
// surfaces by singleWriterBoundary. The one uncovered seam: every other ./hono test uses a hand-rolled
// fake Context, so the real getConnInfo(c) socket path is never exercised. Here track()/honoRequest
// are imported from the public subpath and driven by an actual live request — proving the published
// subpath is consumable by a Hono host, including the real Bun socket address source. DB-free: a
// recording EventSink isolates this seam (no ingest/query — that round-trip lives in bunServeHttpWriter).

// The visitor-token Context variable the ./hono adapter reads (honoToBeaconRequest.getToken).
// Mirrors apps/server's requestLogger augmentation so this acceptance test is self-contained.
declare module 'hono' {
  interface ContextVariableMap {
    beaconVisitorToken?: string;
  }
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const PRODUCT = 'hono-subpath-capstone';
const TOKEN = 'v-hono-subpath';
const IP_HEX = /^[a-f0-9]{64}$/;

describe('capstone — published ./hono subpath drives a real Hono request (M1)', () => {
  const pushed: BeaconEvent[] = [];
  const sink: EventSink = { push: (e) => void pushed.push(e) };
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;

  beforeAll(() => {
    const app = new Hono();

    // Seed the visitor token the way requestLogger does, so the ./hono adapter can read it.
    app.use('*', async (c, next) => {
      const t = c.req.query('_t');
      if (t) c.set('beaconVisitorToken', t);
      await next();
    });

    // Custom event via the public subpath's track(), default hashIPs.
    app.post('/buy', (c) => {
      track(sink, c, { productId: PRODUCT }, 'purchase', { sku: 'a1' });
      return c.body(null, 204);
    });

    // No-XFF event with hashIPs off: forces honoRequest -> real getConnInfo(c) socket source.
    app.get('/socket', (c) => {
      track(sink, c, { productId: PRODUCT, hashIPs: false }, 'socket_probe');
      return c.body(null, 204);
    });

    // honoRequest read surface off a genuine Context.
    app.get('/probe', (c) => {
      const req = honoRequest(c);
      return c.json({ ua: req.header('user-agent') ?? null, token: req.getToken() });
    });

    server = Bun.serve({ port: 0, fetch: app.fetch });
    baseUrl = `http://localhost:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
  });

  test('E2E: track() from the ./hono subpath builds a correct event from a live Hono Context', async () => {
    const res = await fetch(`${baseUrl}/buy?_t=${TOKEN}`, {
      method: 'POST',
      headers: {
        'user-agent': 'CapstoneAgent/1.0',
        'x-app-context': JSON.stringify({ platform: 'ios', appVersion: '1.2.3' }),
        'x-forwarded-for': '203.0.113.7',
      },
    });
    expect(res.status).toBe(204);

    const e = pushed.find((ev) => ev.eventType === 'purchase');
    expect(e).toBeDefined();
    expect(e?.productId).toBe(PRODUCT);
    expect(e?.visitorToken).toBe(TOKEN); // read off the real Context variable bag
    expect(e?.platform).toBe('ios'); // derived from X-App-Context
    expect(e?.properties).toEqual({ sku: 'a1' });
    // hashIPs defaults on: the XFF token is SHA-256 hashed, never stored raw.
    expect((e?.context as { ip?: string }).ip).toBe(sha256('203.0.113.7'));
    expect((e?.context as { user_agent?: string }).user_agent).toBe('CapstoneAgent/1.0');
  });

  test('E2E: with no X-Forwarded-For, the ./hono adapter resolves the real Bun socket (getConnInfo)', async () => {
    const res = await fetch(`${baseUrl}/socket`); // no XFF header
    expect(res.status).toBe(204);

    const e = pushed.find((ev) => ev.eventType === 'socket_probe');
    expect(e).toBeDefined();
    // hashIPs off: the value is the raw socket address from getConnInfo(c) — a real loopback
    // peer (127.0.0.1 / ::1), proving the genuine socket path the fake-Context tests cannot reach.
    const ip = (e?.context as { ip?: string }).ip;
    expect(ip).toBeDefined();
    expect(ip).not.toMatch(IP_HEX); // not hashed (hashIPs off)
    expect(/[.:]/.test(ip as string)).toBe(true); // looks like an IPv4/IPv6 address
  });

  test('honoRequest() from the subpath reads headers and the visitor token off the real Context', async () => {
    const res = await fetch(`${baseUrl}/probe?_t=${TOKEN}`, {
      headers: { 'user-agent': 'ProbeAgent/9' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ua: string | null; token: string | null };
    expect(body.ua).toBe('ProbeAgent/9');
    expect(body.token).toBe(TOKEN);
  });
});
