import { describe, expect, test } from 'bun:test';
import { chromium } from '@playwright/test';
import { Hono } from 'hono';
import { buildServer, type ServerEnv } from '../../apps/server/src/server';
import { closeDb, createDb } from '../../apps/server/src/storage/db';
import { runMigrations } from '../../apps/server/src/storage/migrate';
import { registerDbCoverageGuard, TEST_DB } from '../../apps/server/test/dbGuard';

registerDbCoverageGuard();

describe.skipIf(!TEST_DB)('browser ingest through native transports', () => {
  test('normal flush and navigation unload persist across origins with default capture', async () => {
    const sql = createDb({ connectionString: TEST_DB as string });
    const product = 'browser-ingest-cors';
    let endpoint = '';
    const modules = new Map<string, string>();
    for (const [name, entry] of [
      ['client', 'index'],
      ['web', 'platform/web'],
    ]) {
      const result = await Bun.build({
        entrypoints: [`packages/beacon-client/src/${entry}.ts`],
        target: 'browser',
      });
      expect(result.success).toBe(true);
      modules.set(`/${name}.js`, await (result.outputs[0] as Bun.BuildArtifact).text());
    }
    const pageServer = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (modules.has(path))
          return new Response(modules.get(path), {
            headers: { 'content-type': 'text/javascript' },
          });
        if (path === '/away') return new Response('away');
        return new Response(
          `<script type="module">
        import { BeaconClient } from '/client.js';
        import { useBeaconWeb } from '/web.js';
        const client = new BeaconClient({ endpoint: '${endpoint}', productId: '${product}',
          appContext: { platform: 'web', appVersion: '1' }, visitorToken: 'browser-memory-token',
          flushInterval: 600000 }, { fetch: window.fetch.bind(window) });
        useBeaconWeb(client, { document, window, navigator });
        window.client = client;
        window.ready = true;
      </script>`,
          { headers: { 'content-type': 'text/html' } },
        );
      },
    });
    const origin = `http://127.0.0.1:${pageServer.port}`;
    const { app, beacon } = buildServer({
      DATABASE_URL: TEST_DB,
      PRODUCT_ID: product,
      ADMIN_TOKEN: 'browser-admin',
      CORS_ORIGINS: origin,
    } as ServerEnv);
    const host = new Hono();
    host.use('*', beacon.middleware());
    host.route('/', app);
    const incoming: { method: string; appContext: boolean }[] = [];
    const ingest = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        if (new URL(req.url).pathname === '/analytics/events')
          incoming.push({ method: req.method, appContext: req.headers.has('x-app-context') });
        return host.fetch(req);
      },
    });
    endpoint = `http://127.0.0.1:${ingest.port}/analytics/events`;
    try {
      await runMigrations(sql);
      await sql`DELETE FROM beacon_events WHERE product_id = ${product}`;
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage();
        await page.goto(origin);
        await page.waitForFunction('window.ready === true');
        await page.evaluate(async () => {
          const client = (
            window as unknown as {
              client: { track: (name: string, props: object) => void; flush: () => Promise<void> };
            }
          ).client;
          client.track('browser_normal', { delivery: 'fetch' });
          await client.flush();
          client.track('browser_unload', { delivery: 'sendBeacon' });
        });
        await page.goto(`${origin}/away`);
        const deadline = Date.now() + 5000;
        while (beacon.stats().buffered < 6 && Date.now() < deadline) await Bun.sleep(20);
        await beacon.flush();
        const response = await fetch(
          `${endpoint}?product_id=${product}&after=2020-01-01T00:00:00Z&before=2030-01-01T00:00:00Z`,
          {
            headers: { authorization: 'Bearer browser-admin', origin },
          },
        );
        expect(response.status).toBe(200);
        expect(response.headers.has('access-control-allow-origin')).toBe(false);
        const { events } = (await response.json()) as {
          events: {
            event_type: string;
            product_id: string;
            visitor_token: string;
            user_id: string | null;
            properties: object;
          }[];
        };
        for (const [name, delivery] of [
          ['browser_unload', 'sendBeacon'],
          ['browser_normal', 'fetch'],
        ]) {
          const delivered = events.filter((event) => event.event_type === name);
          expect(delivered).toHaveLength(1);
          expect(delivered[0]).toMatchObject({
            product_id: product,
            visitor_token: 'browser-memory-token',
            user_id: null,
            properties: { delivery },
          });
        }
        expect(events.filter((event) => event.event_type === 'request')).toHaveLength(4);
        expect(incoming.filter((request) => request.method === 'OPTIONS').length).toBeGreaterThan(
          0,
        );
        expect(incoming.filter((request) => request.method === 'POST')).toEqual([
          { method: 'POST', appContext: true },
          { method: 'POST', appContext: false },
        ]);
      } finally {
        await browser.close();
      }
    } finally {
      pageServer.stop(true);
      ingest.stop(true);
      await beacon.shutdown();
      await sql`DELETE FROM beacon_events WHERE product_id = ${product}`;
      await sql`DELETE FROM beacon_meta WHERE product_id = ${product}`;
      await closeDb(sql);
    }
  }, 20000);
});
