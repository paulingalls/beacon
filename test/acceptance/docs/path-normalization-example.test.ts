import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BeaconClient } from '@pi-innovations/beacon-client';
import type { NavBindings } from '@pi-innovations/beacon-client/web';

test('client README normalization example executes through published web exports', async () => {
  const readme = readFileSync(
    join(import.meta.dir, '../../../packages/beacon-client/README.md'),
    'utf8',
  );
  const section = readme.split('## Navigation path normalization')[1];
  expect(section).toBeDefined();
  const snippet = section?.match(/```ts\n([\s\S]*?)```/)?.[1];
  expect(snippet).toBeDefined();
  const dir = join(import.meta.dir, '.normalization-example');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'sample.ts');
  writeFileSync(path, snippet as string);
  const events: Array<{ properties?: { path?: string } }> = [];
  let pathname = '/p/abc/story/xyz';
  const listeners = new Map<string, () => void>();
  const nav: NavBindings = {
    history: {
      pushState: (_data, _unused, url) => {
        pathname = url as string;
      },
      replaceState: (_data, _unused, url) => {
        pathname = url as string;
      },
    },
    location: {
      get pathname() {
        return pathname;
      },
    },
    window: {
      addEventListener: (t, cb) => {
        listeners.set(t, cb);
      },
      removeEventListener: (t) => {
        listeners.delete(t);
      },
    },
  };
  const client = new BeaconClient(
    {
      endpoint: 'https://beacon.example/events',
      productId: 'docs',
      flushInterval: 60_000,
      appContext: { appVersion: '1', platform: 'web' },
    },
    {
      fetch: (async (_url, init) => {
        events.push(...JSON.parse(init?.body as string).events);
        return new Response('{}', { status: 202 });
      }) as typeof fetch,
    },
  );
  let stop = () => {};
  try {
    const sample = (await import(path)) as {
      normalizePath: (p: string) => string | null;
      wireNav: (c: BeaconClient, n: NavBindings) => () => void;
    };
    expect(sample.normalizePath('/p/[legacyId]/story/[storyId]')).toBe(
      '/p/[legacyId]/story/[storyId]',
    );
    stop = sample.wireNav(client, nav);
    nav.history.pushState(null, '', '/invitations/example/preview');
    nav.history.replaceState(null, '', '/p/def/story/uvw');
    await client.flush();
    expect(events.map((e) => e.properties?.path)).toEqual([
      '/p/[legacyId]/story/[storyId]',
      '/p/[legacyId]/story/[storyId]',
    ]);
  } finally {
    stop();
    client.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
