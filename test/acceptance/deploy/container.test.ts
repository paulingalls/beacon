import { afterAll, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  delayFlush,
  externalProbe,
  healthControls,
  policy,
  retention,
  scenario,
  shutdown,
  updateCaddy,
  workload,
} from './container.checks';
import { outbound, validateFault } from './container.faults';
import { block, command, docker, requireDocker, runbook } from './container.fixture';
import {
  documentation,
  gatewayHealth,
  guidance,
  isolated,
  launchTopology,
  persisted,
  query,
  red,
} from './container.guards';
import { databaseControls, shared } from './container.resources';
import { serverMutation } from './container.trace';

validateFault();
afterAll(() => shared.cleanup(), 60000);

test('container documented launch', async () => {
  await expect(requireDocker('beacon-absent-docker')).rejects.toThrow();
  launchTopology();
  expect(() =>
    launchTopology(runbook.replace('--network "$PUBLIC_NETWORK"', '--network "$NETWORK"')),
  ).toThrow();
  expect(() =>
    launchTopology(
      runbook.replace('--network-alias beacon', '-p 8080:8080 --network-alias beacon'),
    ),
  ).toThrow();
  for (const step of [
    'build',
    'network',
    'postgres',
    'address',
    'env',
    'migrate',
    'launch',
    'caddy-config',
    'caddy-launch',
    'stop',
  ]) {
    expect(block(step).length).toBeGreaterThan(0);
    expect(() => block(step, runbook.replace(`<!-- container-${step} -->`, ''))).toThrow();
  }
});
test('container documentation', () => {
  documentation(runbook);
  for (const word of guidance)
    expect(() => documentation(runbook.replaceAll(word, 'omitted'))).toThrow();
});

test(
  'container migration',
  () =>
    scenario(async (f) => {
      const ledger = await f.sql('SELECT filename FROM beacon_migrations ORDER BY filename');
      expect(ledger.split('\n')).toEqual([
        '001_initial_schema.sql',
        '002_funnel_entity_index.sql',
        '003_erasures.sql',
      ]);
      expect(
        await f.sql(
          "SELECT count(*) FROM pg_tables WHERE tablename IN ('beacon_events','beacon_meta','beacon_short_links','beacon_erasures')",
        ),
      ).toBe('4');
      await f.step('migrate');
      expect(await f.sql('SELECT filename FROM beacon_migrations ORDER BY filename')).toBe(ledger);
      await red(
        'migration-command',
        () =>
          f.step(
            'migrate',
            runbook.replace('"$IMAGE" bun run migrate', '"$IMAGE" bun run missing-migration'),
          ),
        /missing-migration/,
      );
      mkdirSync(join(f.dir, 'empty-migrations'));
      await f.sql('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
      await red(
        'missing-sql',
        async () => {
          await command(
            [
              'sh',
              '-eu',
              '-c',
              block('migrate').replace(
                '"$IMAGE" bun run migrate',
                `-v "${f.dir}/empty-migrations:/app/apps/server/src/storage/migrations:ro" "$IMAGE" bun run migrate`,
              ),
            ],
            f.env,
          );
          expect(await f.sql('SELECT count(*) FROM beacon_migrations')).toBe('3');
        },
        /toBe|ENOENT|migration|checksum/,
      );
    }),
  180000,
);

test(
  'container authenticated persistence',
  () =>
    scenario(async (f) => {
      const url = await f.gateway();
      await f.launch();
      await workload(f, url, 'authenticated');
      await f.stop();
      await f.reset();
      await f.launch();
      await f.ready(url);
      await persisted(f, 'authenticated');
      await query(url, 'authenticated');
      await red(
        'postgres-unavailable',
        async () => {
          await docker('stop', f.env.PG as string);
          try {
            await query(url, 'authenticated');
          } finally {
            await docker('start', f.env.PG as string);
          }
        },
        /toBe|timed out/,
      );
      await f.reset();
      f.envFile({ TRUSTED_INGEST_TOKEN: undefined });
      await f.launch();
      await red('trusted-token-unset', () => workload(f, url, 'untrusted'), /toBe/);
      await f.reset();
      await f.step('env');
      await f.launch(
        serverMutation(f, 'isAdmin: makeIsAdmin(env.ADMIN_TOKEN)', 'isAdmin: () => true'),
      );
      await f.ready(url);
      await red('admin-gate-bypass', () => query(url, 'authenticated'), /toBe/);
    }),
  180000,
);

test(
  'container isolation',
  () =>
    scenario(async (f) => {
      const url = await f.gateway();
      await f.launch();
      await workload(f, url, 'isolated');
      await isolated(f);
      await externalProbe(f);
      await red('egress-network', () => externalProbe(f, true), /toBe/);
      await docker('network', 'connect', f.env.PUBLIC_NETWORK as string, f.env.SERVER as string);
      await expect(isolated(f)).rejects.toThrow();
      await docker('network', 'disconnect', f.env.PUBLIC_NETWORK as string, f.env.SERVER as string);
      await docker('network', 'disconnect', f.env.NETWORK as string, f.env.CADDY as string);
      await red('caddy-private-missing', () => isolated(f), /toEqual/);
      await docker('network', 'connect', f.env.NETWORK as string, f.env.CADDY as string);
      await f.reset();
      await f.launch(['-p', '127.0.0.1::8181']);
      await red('beacon-published', () => isolated(f), /toEqual|toBe/);
      await f.reset();
      await f.launch();
      await docker('rm', '-f', f.env.CADDY as string);
      const swapped = runbook
        .replace(
          '--name "$CADDY" --network "$PUBLIC_NETWORK"',
          '--name "$CADDY" --network "$NETWORK"',
        )
        .replace(
          'docker network connect "$NETWORK" "$CADDY"',
          'docker network connect "$PUBLIC_NETWORK" "$CADDY"',
        );
      await f.gateway(swapped);
      await red('caddy-internal-first', () => isolated(f), /toBe/);
    }),
  180000,
);

test(
  'container caddy proxy',
  () =>
    scenario(async (f) => {
      const url = await f.gateway();
      await f.launch();
      await workload(f, url, 'caddy');
      updateCaddy(f, true);
      await docker(
        'exec',
        f.env.CADDY as string,
        'caddy',
        'reload',
        '--config',
        '/etc/caddy/Caddyfile',
        '--adapter',
        'caddyfile',
      );
      expect(
        await docker(
          'exec',
          f.env.SERVER as string,
          'bun',
          '-e',
          `console.log((await fetch('http://127.0.0.1:${f.env.PORT}/health')).status)`,
        ),
      ).toBe('200');
      await red(
        'caddy-wrong-upstream',
        async () => {
          await gatewayHealth(url);
          await workload(f, url, 'caddy-wrong');
        },
        /toBe/,
      );
    }),
  180000,
);

test('container health', () => scenario(healthControls), 240000);

test(
  'container policy wiring',
  () =>
    scenario(async (f) => {
      const url = await f.gateway();
      await f.launch();
      await policy(f, url, 'private-policy');
      for (const [fault, key] of [
        ['ip-mode-unset', 'IP_MODE'],
        ['referrer-mode-unset', 'REFERRER_MODE'],
      ]) {
        await f.reset();
        await f.step('env');
        f.envFile({ [key as string]: undefined });
        await f.launch();
        await red(fault as string, () => policy(f, url, fault as string), /toBeUndefined|toBe/);
      }
    }),
  180000,
);

test(
  'container retention wiring',
  () =>
    scenario(async (f) => {
      const url = await f.gateway();
      await retention(f, url, '1');
      await retention(f, url, '0');
      await retention(f, url, undefined);
      for (const days of [undefined, '0']) {
        await red(
          days === '0' ? 'retention-zero' : 'retention-unset',
          async () => {
            await retention(f, url, days);
            expect(await f.sql("SELECT count(*) FROM beacon_events WHERE event_type='old'")).toBe(
              '0',
            );
          },
          /toBe/,
        );
      }
      await red('retention-overbroad', () => retention(f, url, '1', true), /toBe/);
    }),
  180000,
);

test(
  'container shutdown drain',
  () =>
    scenario(async (f) => {
      const url = await f.gateway();
      const marker = await shutdown(f, url);
      await f.reset();
      await f.launch();
      await f.ready(url);
      await query(url, marker);
      await shutdown(f, url, delayFlush(f), false);
      for (const [fault, from, to] of [
        ['missing-drain', 'await beacon.shutdown();', ''],
        ['nonzero-exit', 'process.exit(0);', 'process.exit(7);'],
        [
          'eager-persistence',
          'const port = Number(process.env.PORT ?? 8080);',
          'setInterval(() => { void beacon.flush(); }, 1); const port = Number(process.env.PORT ?? 8080);',
        ],
      ]) {
        const options = [...delayFlush(f), ...serverMutation(f, from as string, to as string)];
        await red(fault as string, () => shutdown(f, url, options, false), /toBe/);
      }
    }),
  180000,
);

test('container outbound attempts', () => scenario(outbound), 600000);

test('container scenario database isolation and cleanup', databaseControls, 180000);
