import { describe, expect, test } from 'bun:test';
import type { BeaconEvent } from '@pi-innovations/beacon-sdk';
import { Hono } from 'hono';
import { createIngestHandler, type IngestOptions } from './ingest';

const RAW = '/p/abc/story/xyz';
const PATTERN = '/p/[legacyId]/story/[storyId]';
function setup(normalizePath?: IngestOptions['normalizePath']) {
  const pushed: BeaconEvent[] = [];
  const app = new Hono();
  app.post(
    '/events',
    createIngestHandler(
      {
        push: (e) => {
          pushed.push(e);
        },
      },
      {
        productId: 'normalize',
        normalizePath,
        trustedIngestToken: 'secret',
      },
    ),
  );
  return {
    pushed,
    post: (events: unknown[], trusted = false) =>
      app.request('/events', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(trusted ? { authorization: 'Bearer secret' } : {}),
        },
        body: JSON.stringify({ events }),
      }),
  };
}
const event = (event_type: string, properties: Record<string, unknown>) => ({
  event_type,
  properties,
});

describe('normalization ingest', () => {
  test('omission preserves arbitrary values and non-string fields exactly', async () => {
    const { post, pushed } = setup();
    const properties = [
      { path: ' /P/abc%20/story/xyz?secret#hash ' },
      { screen: RAW },
      { path: 42, screen: null },
      {},
    ];
    expect(
      (await post(properties.map((p, i) => event(i === 1 ? 'screen_view' : 'request', p)))).status,
    ).toBe(202);
    expect(pushed.map((e) => e.properties)).toEqual(properties);
  });
  for (const trusted of [false, true]) {
    test(`maps every path and only screen_view screen, trusted=${trusted}`, async () => {
      const { post, pushed } = setup((p) => (p === RAW ? PATTERN : p));
      const res = await post(
        [
          event('request', { path: RAW }),
          event('page_view', { path: RAW }),
          event('custom', { path: RAW, screen: RAW, other: 'keep' }),
          event('screen_view', { path: RAW, screen: RAW }),
          event('custom', { path: 7 }),
        ],
        trusted,
      );
      expect(res.status).toBe(202);
      expect(pushed.map((e) => e.properties)).toEqual([
        { path: PATTERN },
        { path: PATTERN },
        { path: PATTERN, screen: RAW, other: 'keep' },
        { path: PATTERN, screen: PATTERN },
        { path: 7 },
      ]);
    });
  }
  test('null drops whole events, continues mixed batches, and preserves empty strings', async () => {
    const { post, pushed } = setup((p) => (p === '/drop' ? null : p === RAW ? PATTERN : p));
    const res = await post([
      event('request', { path: RAW }),
      event('page_view', { path: '/drop' }),
      event('custom', {}),
      event('screen_view', { path: RAW, screen: '/drop' }),
      event('screen_view', { path: '/drop', screen: RAW }),
      event('request', { path: '' }),
      { event_type: '', properties: { path: RAW } },
    ]);
    expect(await res.json()).toEqual({ accepted: 3, product_id_used: 'normalize' });
    expect(pushed.map((e) => e.properties)).toEqual([{ path: PATTERN }, {}, { path: '' }]);
    const allDropped = await post([event('screen_view', { screen: '/drop' })]);
    expect(((await allDropped.json()) as { accepted: number }).accepted).toBe(0);
  });
  for (const field of ['path', 'screen']) {
    for (const late of [false, true]) {
      test(`throwing ${field}, late=${late} rejects entire batch without raw diagnostics`, async () => {
        const { post, pushed } = setup((p) => {
          if (p === RAW) throw new Error(RAW);
          return p;
        });
        const events = [event('screen_view', { [field]: RAW })];
        if (late) events.unshift(event('request', { path: '/safe' }));
        const res = await post(events);
        expect(res.status).toBe(500);
        const body = await res.text();
        expect(body).toContain('INTERNAL_ERROR');
        expect(body).not.toContain(RAW);
        expect(pushed).toEqual([]);
      });
    }
  }
});
