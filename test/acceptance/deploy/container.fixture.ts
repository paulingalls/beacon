import { expect } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { block, command, docker, runbook, until } from './container.commands';
import { shared } from './container.resources';

export { block, command, docker, requireDocker, root, runbook, until } from './container.commands';
export class ContainerFixture {
  readonly id = `beacon-container-${crypto.randomUUID().slice(0, 8)}`;
  readonly dir = mkdtempSync(join(tmpdir(), 'beacon-container-'));
  readonly database = `case_${crypto.randomUUID().replaceAll('-', '')}`;
  readonly env: Record<string, string> = {
    ...shared.env,
    DATABASE_NAME: this.database,
    SERVER: `${this.id}-server`,
    CADDY: `${this.id}-caddy`,
    CONFIG_DIR: this.dir,
    PG_PASSWORD: 'fixture-secret',
    ADMIN_TOKEN: 'fixture-admin',
    TRUSTED_INGEST_TOKEN: 'fixture-ingest',
    PORT: '8181',
    HTTP_PORT: '0',
    HTTPS_PORT: '0',
    BIND_IP: '127.0.0.1',
    SITE: 'http://:80',
  };
  readonly containers = new Set<string>();
  async step(name: string, source = runbook) {
    return command(['sh', '-eu', '-c', block(name, source)], this.env);
  }
  async setup() {
    await shared.ensure();
    await shared.createDatabase(this.database);
    const address = await command(
      ['sh', '-eu', '-c', `${block('address')}\nprintf '%s\\n%s' "$PG_IP" "$DATABASE_URL"`],
      this.env,
    );
    const [ip, url] = address.split('\n');
    expect(ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    this.env.PG_IP = ip as string;
    this.env.DATABASE_URL = url as string;
    await this.step('env');
  }
  async sql(query: string) {
    return docker(
      'exec',
      this.env.PG as string,
      'psql',
      '-XAt',
      '-U',
      'beacon',
      '-d',
      this.database,
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      query,
    );
  }
  async launch(options: string[] = [], argv: string[] = []) {
    const name = this.env.SERVER as string;
    this.containers.add(name);
    if (options.length || argv.length) {
      await docker(
        'run',
        '-d',
        '--name',
        name,
        '--network',
        this.env.NETWORK as string,
        '--network-alias',
        'beacon',
        '--env-file',
        join(this.dir, 'beacon.env'),
        ...options,
        this.env.IMAGE as string,
        ...argv,
      );
    } else await this.step('launch');
  }
  async gateway(source = runbook) {
    this.containers.add(this.env.CADDY as string);
    await this.step('caddy-config', source);
    await this.step('caddy-launch', source);
    try {
      return `http://${await docker('port', this.env.CADDY as string, '80/tcp')}`;
    } catch (error) {
      throw new Error(`${error}\n${await this.diagnostics()}`);
    }
  }
  async diagnostics() {
    const results = await Promise.all(
      [this.env.SERVER as string, this.env.CADDY as string].map(async (name) => {
        const state = await docker('inspect', '--format', '{{json .State}}', name);
        const process = Bun.spawn(['docker', 'logs', '--tail', '20', name], {
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const [stdout, stderr] = await Promise.all([
          new Response(process.stdout).text(),
          new Response(process.stderr).text(),
          process.exited,
        ]);
        const logs = stdout + stderr;
        return `${name}: ${state}\n${logs}`;
      }),
    );
    return results.join('\n');
  }
  async ready(url: string) {
    try {
      await until('Caddy upstream ready', async () => {
        try {
          return (await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) })).ok;
        } catch {
          return false;
        }
      });
    } catch (error) {
      throw new Error(`${error}\n${await this.diagnostics()}`);
    }
  }
  async reset() {
    const name = this.env.SERVER as string;
    if (this.containers.has(name)) {
      await docker('rm', '-f', name);
      this.containers.delete(name);
    }
  }
  envFile(changes: Record<string, string | undefined>) {
    const path = join(this.dir, 'beacon.env');
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    for (const [key, value] of Object.entries(changes)) {
      const i = lines.findIndex((line) => line.startsWith(`${key}=`));
      if (i >= 0) lines.splice(i, 1);
      if (value !== undefined) lines.push(`${key}=${value}`);
    }
    writeFileSync(path, `${lines.join('\n')}\n`);
  }
  async stop(name = this.env.SERVER as string) {
    await command(['sh', '-eu', '-c', block('stop')], { ...this.env, SERVER: name });
    const state = JSON.parse(await docker('inspect', '--format', '{{json .State}}', name));
    expect(state.Status).toBe('exited');
    expect(state.ExitCode).toBe(0);
    expect(state.OOMKilled).toBe(false);
  }
  async cleanup() {
    for (const name of this.containers) {
      try {
        await docker('rm', '-f', name);
      } catch {
        /* setup may fail before creation */
      }
    }
    await shared.dropDatabase(this.database);
    rmSync(this.dir, { recursive: true, force: true });
  }
  preload(contents: string) {
    const path = join(this.dir, `timing-${crypto.randomUUID()}.ts`);
    writeFileSync(path, contents);
    return ['-v', `${path}:/diagnostic.ts:ro`, '-e', 'BUN_OPTIONS=--preload=/diagnostic.ts'];
  }
}
export async function ingest(url: string, marker: string) {
  const response = await fetch(`${url}/analytics/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer fixture-ingest' },
    body: JSON.stringify({
      product_id: 'container',
      events: [
        {
          event_type: marker,
          user_id: 'container-user',
          properties: {},
          context: {
            ip: '203.0.113.9',
            referrer: 'https://user:secret@example.com/path?q=secret#private',
          },
        },
      ],
    }),
  });
  expect(response.status).toBe(202);
  expect((await response.json()).accepted).toBe(1);
}
