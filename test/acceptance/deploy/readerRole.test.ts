import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registrationControls } from './container.guards';
import { fixture, password, scriptPath, tables } from './readerRole.fixture';

const db = fixture();
const temp = mkdtempSync(join(tmpdir(), 'reader-role-'));
let publicTemp: string;
let copyNumber = 0;
async function tempAcl() {
  return JSON.stringify(
    await db.sql`SELECT privilege_type, is_grantable FROM pg_database,
    LATERAL aclexplode(COALESCE(datacl, acldefault('d',datdba))) a
    WHERE datname=current_database() AND grantee=0 AND privilege_type='TEMPORARY'`,
  );
}
function succeeds(result: ReturnType<typeof db.probe>) {
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
}
function refused(query: string) {
  const result = db.probe(`BEGIN; ${query}; ROLLBACK;`);
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).not.toBe(0);
  expect(result.stderr).toContain('42501');
}
async function injected(grant: string, undo: string, assertion: () => void) {
  await db.sql.unsafe(grant);
  try {
    expect(assertion).toThrow();
  } finally {
    await db.sql.unsafe(undo);
  }
  assertion();
}
function copyScript(transform: (s: string) => string) {
  const path = join(temp, `provision-${copyNumber++}.sql`);
  writeFileSync(path, transform(readFileSync(scriptPath, 'utf8')));
  return path;
}

beforeAll(async () => {
  await db.setup();
  publicTemp = await tempAcl();
  succeeds(db.provision());
}, 20000);
afterAll(async () => {
  await db.cleanup();
  rmSync(temp, { recursive: true, force: true });
});

test('provisioning twice succeeds and reconciles excess direct grants', async () => {
  await db.sql.unsafe(`GRANT ALL ON ${tables.join(',')} TO beacon_reader;
    GRANT UPDATE (event_type) ON beacon_events TO beacon_reader;
    ALTER ROLE beacon_reader SUPERUSER CREATEDB CREATEROLE REPLICATION BYPASSRLS;
    GRANT CREATE ON SCHEMA public TO beacon_reader;
    GRANT CREATE ON DATABASE ${db.name} TO beacon_reader`);
  succeeds(db.provision());
  for (const table of tables) refused(`DELETE FROM ${table}`);
  refused("UPDATE beacon_events SET event_type='updated'");
  const [attributes] =
    await db.sql`SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname='beacon_reader'`;
  expect(Object.values(attributes)).toEqual([false, false, false, false, false]);
  refused('CREATE TABLE public.forbidden(id int)');
  refused('CREATE SCHEMA forbidden');
});
test('PUBLIC TEMP preserved across provisioning', async () => {
  expect(await tempAcl()).toBe(publicTemp);
  succeeds(db.provision());
  expect(await tempAcl()).toBe(publicTemp);
  const path = copyScript((s) =>
    s.replace(
      'COMMIT;',
      `REVOKE TEMPORARY ON DATABASE ${db.name} FROM PUBLIC;
    GRANT TEMPORARY ON DATABASE ${db.name} TO beacon_reader; COMMIT;`,
    ),
  );
  try {
    succeeds(db.provision(path));
    succeeds(db.probe('CREATE TEMP TABLE allowed(id int)'));
    expect(await tempAcl()).not.toBe(publicTemp);
  } finally {
    await db.sql.unsafe(`GRANT TEMPORARY ON DATABASE ${db.name} TO PUBLIC;
      REVOKE TEMPORARY ON DATABASE ${db.name} FROM beacon_reader`);
  }
  expect(await tempAcl()).toBe(publicTemp);
});
test('reader identity is beacon_reader and operator password authenticates', () => {
  const identity = (asReader = true) => {
    const r = db.probe('SELECT current_user', asReader);
    succeeds(r);
    expect(r.stdout.trim()).toBe('beacon_reader');
  };
  identity();
  expect(() => identity(false)).toThrow();
  const wrong = db.probe('SELECT current_user', true, 'wrong');
  expect(wrong.status).not.toBe(0);
  expect(wrong.stderr).toContain('password authentication failed');
});

const inserts: Record<string, string> = {
  beacon_events: "(product_id,event_type) VALUES ('new','new')",
  beacon_meta: "(product_id,event_type) VALUES ('new','new')",
  beacon_short_links: "(code,destination,product_id) VALUES ('new','https://example.com','new')",
  beacon_erasures: "(user_id_hash,count) VALUES ('new',1)",
};
const updates: Record<string, string> = {
  beacon_events: "event_type='updated' WHERE product_id='fixture'",
  beacon_meta: "count=2 WHERE product_id='fixture'",
  beacon_short_links: "click_count=2 WHERE code='fixture'",
  beacon_erasures: "count=2 WHERE user_id_hash='fixture'",
};
for (const table of tables) {
  test(`reader SELECT ${table} succeeds`, async () => {
    const read = () => {
      const r = db.probe(`SELECT count(*) FROM ${table}`);
      succeeds(r);
      expect(r.stdout.trim()).toBe('1');
    };
    read();
    await injected(
      `REVOKE SELECT ON ${table} FROM beacon_reader`,
      `GRANT SELECT ON ${table} TO beacon_reader`,
      read,
    );
  });
  for (const [operation, query] of [
    ['INSERT', `INSERT INTO ${table} ${inserts[table]}`],
    ['UPDATE', `UPDATE ${table} SET ${updates[table]}`],
    ['DELETE', `DELETE FROM ${table}`],
  ]) {
    test(`reader ${operation} ${table} refused`, async () => {
      const check = () => refused(query as string);
      check();
      await injected(
        `GRANT ${operation} ON ${table} TO beacon_reader`,
        `REVOKE ${operation} ON ${table} FROM beacon_reader`,
        check,
      );
    });
  }
  for (const [operation, query] of [
    ['ALTER', `ALTER TABLE ${table} ADD COLUMN forbidden int`],
    ['DROP', `DROP TABLE ${table}`],
  ]) {
    test(`reader ${operation} ${table} refused`, async () => {
      const check = () => refused(query as string);
      check();
      const [{ current_user: owner }] = await db.sql`SELECT current_user`;
      await injected(
        `ALTER TABLE ${table} OWNER TO beacon_reader`,
        `ALTER TABLE ${table} OWNER TO "${owner}"`,
        check,
      );
    });
  }
}
for (const [kind, query, target] of [
  ['table', 'CREATE TABLE public.forbidden(id int)', 'SCHEMA public'],
  ['schema', 'CREATE SCHEMA forbidden', `DATABASE ${db.name}`],
]) {
  test(`reader permanent ${kind} CREATE refused`, async () => {
    const check = () => refused(query as string);
    check();
    await injected(
      `GRANT CREATE ON ${target} TO beacon_reader`,
      `REVOKE CREATE ON ${target} FROM beacon_reader`,
      check,
    );
  });
}
test('reader temporary table succeeds', async () => {
  const check = () =>
    succeeds(
      db.probe(
        'CREATE TEMP TABLE allowed(id int); INSERT INTO allowed VALUES (1); SELECT * FROM allowed; DROP TABLE allowed',
      ),
    );
  check();
  await injected(
    `REVOKE TEMPORARY ON DATABASE ${db.name} FROM PUBLIC, beacon_reader`,
    `GRANT TEMPORARY ON DATABASE ${db.name} TO PUBLIC`,
    check,
  );
  await db.sql.unsafe(`REVOKE TEMPORARY ON DATABASE ${db.name} FROM PUBLIC, beacon_reader`);
  try {
    const before = await tempAcl();
    succeeds(db.provision());
    expect(await tempAcl()).toBe(before);
    check();
  } finally {
    await db.sql.unsafe(`GRANT TEMPORARY ON DATABASE ${db.name} TO PUBLIC`);
  }
});

test('missing password fails', () => {
  for (const value of [undefined, '']) {
    const r = db.provision(scriptPath, { BEACON_READER_PASSWORD: value });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('BEACON_READER_PASSWORD');
  }
});
test('missing required table fails', async () => {
  await db.sql`ALTER TABLE beacon_erasures RENAME TO hidden_erasures`;
  try {
    const r = db.provision();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('beacon_erasures');
  } finally {
    await db.sql`ALTER TABLE hidden_erasures RENAME TO beacon_erasures`;
  }
});
test('unsafe inherited privileges fail', async () => {
  const [{ current_user: owner }] = await db.sql`SELECT current_user`;
  const cases = [
    [
      'CREATE SCHEMA additional; GRANT CREATE ON SCHEMA additional TO PUBLIC',
      'DROP SCHEMA additional',
    ],
    [
      'CREATE SCHEMA additional; GRANT CREATE ON SCHEMA additional TO beacon_reader',
      'DROP SCHEMA additional',
    ],
    ['GRANT INSERT ON beacon_events TO PUBLIC', 'REVOKE INSERT ON beacon_events FROM PUBLIC'],
    [
      'GRANT UPDATE (event_type) ON beacon_events TO PUBLIC',
      'REVOKE UPDATE (event_type) ON beacon_events FROM PUBLIC',
    ],
    [
      `ALTER DATABASE ${db.name} OWNER TO beacon_reader`,
      `ALTER DATABASE ${db.name} OWNER TO "${owner}"`,
    ],
    [
      'ALTER SCHEMA public OWNER TO beacon_reader',
      `ALTER SCHEMA public OWNER TO pg_database_owner`,
    ],
    ['GRANT CREATE ON SCHEMA public TO PUBLIC', 'REVOKE CREATE ON SCHEMA public FROM PUBLIC'],
    [
      `GRANT CREATE ON DATABASE ${db.name} TO PUBLIC`,
      `REVOKE CREATE ON DATABASE ${db.name} FROM PUBLIC`,
    ],
    [
      'CREATE ROLE fixture_parent; GRANT fixture_parent TO beacon_reader',
      'REVOKE fixture_parent FROM beacon_reader; DROP ROLE fixture_parent',
    ],
    [
      'ALTER TABLE beacon_events OWNER TO beacon_reader',
      `ALTER TABLE beacon_events OWNER TO "${owner}"`,
    ],
  ];
  for (const [grant, undo] of cases) {
    await db.sql.unsafe(grant as string);
    try {
      const r = db.provision();
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('Unsafe beacon_reader');
    } finally {
      await db.sql.unsafe(undo as string);
    }
  }
});
test('failed provisioning rolls back role and ACL changes', async () => {
  async function snapshot() {
    return JSON.stringify(
      await db.sql`SELECT
      (SELECT row_to_json(r) FROM pg_authid r WHERE rolname='beacon_reader') role,
      (SELECT json_agg(relacl ORDER BY relname) FROM pg_class WHERE relname LIKE 'beacon_%') tables,
      (SELECT nspacl FROM pg_namespace WHERE nspname='public') schema,
      (SELECT datacl FROM pg_database WHERE datname=current_database()) database`,
    );
  }
  const before = await snapshot();
  const path = copyScript((s) => s.replace('COMMIT;', 'SELECT deliberate_sql_error; COMMIT;'));
  const r = db.provision(path, { BEACON_READER_PASSWORD: 'changed' });
  expect(r.status).not.toBe(0);
  expect(await snapshot()).toBe(before);
  succeeds(db.probe('SELECT current_user'));
  const unwrapped = copyScript((s) =>
    s.replace('BEGIN;', '').replace('COMMIT;', 'SELECT deliberate_sql_error;'),
  );
  try {
    expect(db.provision(unwrapped, { BEACON_READER_PASSWORD: 'changed' }).status).not.toBe(0);
    expect(await snapshot()).not.toBe(before);
  } finally {
    succeeds(db.provision());
  }
  await db.sql`DROP OWNED BY beacon_reader`;
  await db.sql`DROP ROLE beacon_reader`;
  expect(db.provision(path).status).not.toBe(0);
  expect(await db.sql`SELECT 1 FROM pg_roles WHERE rolname='beacon_reader'`).toHaveLength(0);
  succeeds(db.provision());
});
test('SQL errors are fatal', () => {
  const path = copyScript((s) => `${s}\nSELECT deliberate_sql_error;`);
  expect(db.provision(path).status).not.toBe(0);
  const command = `psql -X --dbname "$ADMIN_DATABASE_URL" --set=ON_ERROR_STOP=0 --file ${path}`;
  expect(db.command(command).status).toBe(0);
});
test('missing prerequisites fail loudly', () => {
  const noPsql = db.provision(scriptPath, { PATH: '/nonexistent' });
  expect(noPsql.status).not.toBe(0);
  expect(noPsql.stderr).toContain('psql');
  expect(
    db.provision(scriptPath, { ADMIN_DATABASE_URL: 'postgres://localhost:1/no_db' }).status,
  ).not.toBe(0);
  const r = db.provision(scriptPath, {
    ADMIN_DATABASE_URL: db.readerUrl.toString(),
    PGPASSWORD: password,
  });
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain('permission denied');
});
test('slow suite registered and story excludes subprocess suite', registrationControls);

test('non-superuser operator provisions and reruns with owner and role authority', async () => {
  const operator = `${db.name}_operator`;
  const [{ current_user: owner }] = await db.sql`SELECT current_user`;
  await db.sql.unsafe(`CREATE ROLE ${operator} LOGIN CREATEROLE PASSWORD 'operator-test'`);
  const url = new URL(db.databaseUrl);
  url.username = operator;
  url.password = 'operator-test';
  try {
    await db.sql`DROP OWNED BY beacon_reader`;
    await db.sql`DROP ROLE beacon_reader`;
    await db.sql.unsafe(
      `ALTER DATABASE ${db.name} OWNER TO ${operator}; ALTER SCHEMA public OWNER TO ${operator}`,
    );
    for (const table of tables) await db.sql.unsafe(`ALTER TABLE ${table} OWNER TO ${operator}`);
    for (let run = 0; run < 2; run++)
      succeeds(db.provision(scriptPath, { ADMIN_DATABASE_URL: url.toString() }));
    succeeds(db.probe('SELECT current_user'));
    refused('DELETE FROM beacon_events');
  } finally {
    for (const table of tables) await db.sql.unsafe(`ALTER TABLE ${table} OWNER TO "${owner}"`);
    await db.sql.unsafe(
      `ALTER DATABASE ${db.name} OWNER TO "${owner}"; ALTER SCHEMA public OWNER TO pg_database_owner`,
    );
    await db.sql.unsafe(`DROP OWNED BY ${operator}; DROP ROLE ${operator}`);
    succeeds(db.provision());
  }
});
