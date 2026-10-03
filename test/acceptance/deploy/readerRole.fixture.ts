import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { runMigrations } from '../../../apps/server/src/storage/migrate';

export const root = join(import.meta.dir, '../../..');
export const password = "reader ' \\ $ ; secret";
export const tables = ['beacon_events', 'beacon_meta', 'beacon_short_links', 'beacon_erasures'];
export const scriptPath = join(root, 'scripts/create-reader-role.sql');
export function documentedCommand() {
  const doc = readFileSync(join(root, 'docs/DEPLOYMENT.md'), 'utf8');
  const blocks = [...doc.matchAll(/<!-- reader-provision -->\s*```bash\n([^`]+)```/g)];
  if (blocks.length !== 1)
    throw new Error('Exactly one documented reader provisioning command required');
  return blocks[0]?.[1] as string;
}

export function fixture() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('reader suite requires TEST_DATABASE_URL and a dedicated test cluster');
  const adminUrl = new URL(url);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(adminUrl.hostname)) {
    throw new Error('reader suite only mutates a dedicated local test cluster');
  }
  const name = `reader_${process.pid}`;
  const databaseUrl = new URL(url);
  databaseUrl.pathname = `/${name}`;
  const readerUrl = new URL(databaseUrl);
  readerUrl.username = 'beacon_reader';
  readerUrl.password = '';
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  const sql = postgres(databaseUrl.toString(), { max: 1, onnotice: () => {} });
  let created = false;
  let ownedRole = false;

  function command(commandText: string, env: Record<string, string | undefined> = {}) {
    return spawnSync('/bin/bash', ['-c', commandText], {
      cwd: root,
      encoding: 'utf8',
      timeout: 15000,
      env: {
        ...process.env,
        PGCONNECT_TIMEOUT: '3',
        ADMIN_DATABASE_URL: databaseUrl.toString(),
        BEACON_READER_PASSWORD: password,
        ...env,
      },
    });
  }
  function provision(path = scriptPath, env: Record<string, string | undefined> = {}) {
    return command(documentedCommand().replace('scripts/create-reader-role.sql', path), env);
  }
  function probe(query: string, asReader = true, suppliedPassword = password) {
    return spawnSync(
      'psql',
      [
        '-X',
        '--dbname',
        asReader ? readerUrl.toString() : databaseUrl.toString(),
        '--set=ON_ERROR_STOP=1',
        '--set=VERBOSITY=verbose',
        '-At',
        '-c',
        query,
      ],
      {
        encoding: 'utf8',
        timeout: 15000,
        env: {
          ...process.env,
          PGCONNECT_TIMEOUT: '3',
          ...(asReader ? { PGPASSWORD: suppliedPassword } : {}),
        },
      },
    );
  }
  async function setup() {
    const roles = await admin`SELECT 1 FROM pg_roles WHERE rolname = 'beacon_reader'`;
    if (roles.length)
      throw new Error(
        'Refusing to mutate pre-existing beacon_reader; use a dedicated clean test cluster',
      );
    await admin.unsafe(`CREATE DATABASE ${name}`);
    created = true;
    await runMigrations(sql);
    await sql`INSERT INTO beacon_events(product_id,event_type) VALUES ('fixture','fixture')`;
    await sql`INSERT INTO beacon_meta(product_id,event_type) VALUES ('fixture','fixture')`;
    await sql`INSERT INTO beacon_short_links(code,destination,product_id) VALUES ('fixture','https://example.com','fixture')`;
    await sql`INSERT INTO beacon_erasures(user_id_hash,count) VALUES ('fixture',1)`;
    ownedRole = true;
  }
  async function cleanup() {
    await sql.end();
    if (created) await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`);
    if (ownedRole) await admin.unsafe('DROP ROLE IF EXISTS beacon_reader');
    await admin.end();
  }
  return { name, sql, admin, setup, cleanup, provision, probe, command, databaseUrl, readerUrl };
}
