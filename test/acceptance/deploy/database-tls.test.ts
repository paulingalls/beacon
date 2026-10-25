import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import { buildServer } from '../../../apps/server/src/server';
import { closeDb, createDb } from '../../../apps/server/src/storage/db';
import { runMigrations } from '../../../apps/server/src/storage/migrate';
import { registerDbCoverageGuard, TEST_DB } from '../../../apps/server/test/dbGuard';
import { tlsDatabase } from './database-tls.fixture';

registerDbCoverageGuard();
let proxy: Awaited<ReturnType<typeof tlsDatabase>>;
beforeAll(async () => {
  const sql = createDb({ connectionString: TEST_DB as string });
  try {
    await runMigrations(sql);
  } finally {
    await closeDb(sql);
  }
  proxy = await tlsDatabase(TEST_DB as string);
});
afterAll(async () => {
  await proxy?.close();
});

for (const [name, mode, wrongCa, hostname, error] of [
  ['trusted CA', 'verify-full', false, 'localhost', undefined],
  ['different CA', 'require', true, 'localhost', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'],
  ['hostname mismatch', 'require', false, 'wrong.example', 'ERR_TLS_CERT_ALTNAME_INVALID'],
] as const) {
  test(`server schema over TLS: ${name}`, async () => {
    proxy.hostname(hostname);
    const warnings = spyOn(console, 'warn').mockImplementation(() => {});
    const { app, beacon } = buildServer({
      DATABASE_URL: proxy.url(mode),
      DATABASE_CA_CERT: wrongCa ? proxy.other : proxy.ca,
      ADMIN_TOKEN: 'tls-admin',
    });
    const socket = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: app.fetch });
    try {
      const response = await fetch(new URL('/analytics/schema', socket.url), {
        headers: { authorization: 'Bearer tls-admin' },
        signal: AbortSignal.timeout(6000),
      });
      if (error) {
        expect(response.status).not.toBe(200);
        expect(warnings.mock.calls.flat().join('\n')).toMatch(
          error === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
            ? /unable to verify the first certificate/
            : /ERR_TLS_CERT_ALTNAME_INVALID/,
        );
      } else {
        expect(response.status).toBe(200);
        expect(await response.json()).toHaveProperty('dimensions');
      }
    } finally {
      await socket.stop(true);
      await beacon.shutdown();
      warnings.mockRestore();
    }
  }, 10000);
}
for (const [name, path] of [
  ['missing', 'missing'],
  ['empty', ''],
  ['malformed', 'malformed'],
] as const) {
  test(`invalid DATABASE_CA_CERT ${name} fails before connecting`, async () => {
    await Bun.write(
      join(proxy.dir, 'malformed'),
      '-----BEGIN CERTIFICATE-----\nbroken\n-----END CERTIFICATE-----\n',
    );
    const count = proxy.accepted();
    let beacon: ReturnType<typeof buildServer>['beacon'] | undefined;
    try {
      expect(() => {
        beacon = buildServer({
          DATABASE_URL: proxy.url('require'),
          DATABASE_CA_CERT: path ? join(proxy.dir, path) : '',
        }).beacon;
      }).toThrow('DATABASE_CA_CERT');
      expect(proxy.accepted()).toBe(count);
    } finally {
      await beacon?.shutdown();
    }
  });
}
for (const [name, mode, path, error] of [
  ['trusted', 'verify-full', 'ca.crt', undefined],
  ['wrong CA', 'require', 'other.crt', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'],
  ['missing', 'require', 'missing', 'DATABASE_CA_CERT'],
] as const) {
  test(`migration CLI over TLS: ${name}`, async () => {
    proxy.hostname('localhost');
    const child = Bun.spawn(['bun', 'run', 'migrate'], {
      env: {
        ...process.env,
        DATABASE_URL: proxy.url(mode),
        DATABASE_CA_CERT: join(proxy.dir, path),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const timeout = setTimeout(() => child.kill(), 7000);
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (error) {
        expect(code).not.toBe(0);
        expect(stderr).toContain(error);
      } else {
        expect(code, stderr).toBe(0);
        expect(stdout).toMatch(/No pending migrations|Applied:/);
      }
    } finally {
      clearTimeout(timeout);
      child.kill();
    }
  }, 10000);
}
