import { expect } from 'bun:test';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { block, command, docker, requireDocker, until } from './container.commands';

class SuiteResources {
  readonly id = `beacon-suite-${crypto.randomUUID().slice(0, 8)}`;
  readonly dir = mkdtempSync(join(tmpdir(), 'beacon-suite-'));
  readonly env = {
    IMAGE: `${this.id}:app`,
    OBSERVER_IMAGE: `${this.id}:observer`,
    NETWORK: `${this.id}-private`,
    PUBLIC_NETWORK: `${this.id}-public`,
    PG: `${this.id}-pg`,
    VOLUME: `${this.id}-volume`,
    PG_PASSWORD: 'fixture-secret',
    DATABASE_NAME: 'beacon',
  };
  pending?: Promise<void>;
  observerPending?: Promise<void>;
  readonly containers = new Set<string>();
  readonly databases = new Set<string>();
  async step(name: string) {
    return command(['sh', '-eu', '-c', block(name)], this.env);
  }
  ensure() {
    this.pending ??= this.provision();
    return this.pending;
  }
  private async provision() {
    await requireDocker(
      Bun.env.BEACON_CONTAINER_FAULT === 'docker-unavailable' ? 'beacon-absent-docker' : 'docker',
    );
    await docker('pull', 'postgres:16-alpine');
    await docker('pull', 'caddy:2-alpine');
    await this.step('build');
    await this.step('network');
    this.containers.add(this.env.PG);
    await this.step('postgres');
    await until('Postgres TCP ready', async () => {
      try {
        await docker(
          'exec',
          this.env.PG,
          'pg_isready',
          '-h',
          '127.0.0.1',
          '-U',
          'beacon',
          '-d',
          'beacon',
        );
        return true;
      } catch {
        return false;
      }
    });
  }
  sql(query: string) {
    return docker(
      'exec',
      this.env.PG,
      'psql',
      '-XAt',
      '-U',
      'beacon',
      '-d',
      'beacon',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      query,
    );
  }
  async createDatabase(name: string) {
    if (!/^case_[a-f0-9]+$/.test(name)) throw new Error('invalid scenario database name');
    await this.sql(`CREATE DATABASE "${name}"`);
    this.databases.add(name);
  }
  async dropDatabase(name: string) {
    if (!this.databases.has(name)) return;
    await this.sql(`DROP DATABASE "${name}" WITH (FORCE)`);
    this.databases.delete(name);
  }
  async exists(name: string) {
    if (!/^case_[a-f0-9]+$/.test(name)) throw new Error('invalid scenario database name');
    return (await this.sql(`SELECT count(*) FROM pg_database WHERE datname='${name}'`)) === '1';
  }
  async observer(source: string, destination: string) {
    this.observerPending ??= this.buildObserver(source);
    await this.observerPending;
    cpSync(join(this.dir, 'probe.so'), destination);
  }
  private async buildObserver(source: string) {
    writeFileSync(join(this.dir, 'probe.c'), source);
    writeFileSync(
      join(this.dir, 'Dockerfile'),
      'FROM alpine:3.21\nRUN apk add --no-cache strace gcc musl-dev\nCOPY probe.c /probe.c\nRUN gcc -pthread -shared -fPIC /probe.c -o /probe.so\n',
    );
    await docker('build', '-t', this.env.OBSERVER_IMAGE, this.dir);
    const carrier = `${this.id}-probe-build`;
    this.containers.add(carrier);
    await docker('create', '--name', carrier, this.env.OBSERVER_IMAGE);
    await docker('cp', `${carrier}:/probe.so`, join(this.dir, 'probe.so'));
    await docker('rm', carrier);
    this.containers.delete(carrier);
  }
  async cleanup() {
    if (!this.pending && !this.observerPending) {
      rmSync(this.dir, { recursive: true, force: true });
      return;
    }
    for (const db of this.databases) await this.dropDatabase(db);
    const actions = [
      ...[...this.containers].map((name) => ['rm', '-f', name]),
      ...[this.env.NETWORK, this.env.PUBLIC_NETWORK].map((name) => ['network', 'rm', name]),
      ['volume', 'rm', this.env.VOLUME],
      ['image', 'rm', this.env.IMAGE],
      ['image', 'rm', this.env.OBSERVER_IMAGE],
    ];
    for (const args of actions) {
      try {
        await docker(...args);
      } catch (error) {
        if (!/No such|not found/.test(String(error))) throw error;
      }
    }
    rmSync(this.dir, { recursive: true, force: true });
  }
}
export const shared = new SuiteResources();

export async function databaseControls() {
  const { scenario } = await import('./container.checks');
  const { inspect, red } = await import('./container.guards');

  const { ContainerFixture } = await import('./container.fixture');
  const a = new ContainerFixture();
  const b = new ContainerFixture();
  const removed = async (name: string) => expect(await shared.exists(name)).toBe(false);
  try {
    await a.setup();
    const pid = (await inspect(a.env.PG as string)).State.Pid;
    await b.setup();
    expect((await inspect(b.env.PG as string)).State.Pid).toBe(pid);
    expect(a.env.PG).toBe(b.env.PG);
    expect(a.database).not.toBe(b.database);
    await a.step('migrate');
    await b.step('migrate');
    await a.sql(
      "CREATE TABLE isolated_marker(value text); INSERT INTO isolated_marker VALUES ('A'); INSERT INTO beacon_events(product_id,event_type) VALUES ('container','only_a')",
    );
    await b.sql("INSERT INTO beacon_events(product_id,event_type) VALUES ('container','only_b')");
    const distinct = async (sql: (q: string) => Promise<string>) => {
      expect(await sql("SELECT to_regclass('isolated_marker') IS NULL")).toBe('t');
      expect(await sql("SELECT count(*) FROM beacon_events WHERE event_type='only_a'")).toBe('0');
    };
    await distinct((q) => b.sql(q));
    expect(await a.sql("SELECT count(*) FROM beacon_events WHERE event_type='only_b'")).toBe('0');
    await red('reused-database', () => distinct((q) => a.sql(q)), /toBe/);
    await red('database-cleanup-missing', () => removed(a.database), /toBe/);
  } finally {
    await a.cleanup();
    await b.cleanup();
  }
  await removed(a.database);
  await removed(b.database);
  let failedDatabase = '';
  await expect(
    scenario(async (f) => {
      failedDatabase = f.database;
      await f.sql('CREATE TABLE failure_marker(value text)');
      throw new Error('injected scenario failure');
    }),
  ).rejects.toThrow('injected scenario failure');
  await removed(failedDatabase);
}
