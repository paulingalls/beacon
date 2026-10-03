import { expect } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const root = join(import.meta.dir, '../../..');
export const runbook = readFileSync(join(root, 'docs/DEPLOYMENT.md'), 'utf8');
export function block(step: string, source = runbook) {
  const matches = [
    ...source.matchAll(
      new RegExp(`<!-- container-${step} -->\\s*\x60\x60\x60bash\\n([\\s\\S]*?)\x60\x60\x60`, 'g'),
    ),
  ];
  if (matches.length !== 1)
    throw new Error(`container-${step}: expected exactly one executable block`);
  return matches[0]?.[1] as string;
}
export async function command(argv: string[], env: Record<string, string> = {}, timeout = 120000) {
  const process = Bun.spawn(argv, {
    cwd: root,
    env: { ...Bun.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => process.kill(), timeout);
  try {
    const [status, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    if (status !== 0)
      throw new Error(`${argv[0]} ${argv[1]} failed (${status}): ${stderr || stdout}`);
    return stdout.trim();
  } finally {
    clearTimeout(timer);
  }
}
export const docker = (...args: string[]) => command(['docker', ...args]);
export async function until(label: string, check: () => Promise<boolean>, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(100);
  }
  throw new Error(`Timeout: ${label}`);
}
export class ContainerFixture {
  readonly id = `beacon-container-${crypto.randomUUID().slice(0, 8)}`;
  readonly dir = mkdtempSync(join(tmpdir(), 'beacon-container-'));
  readonly env: Record<string, string> = {
    IMAGE: `${this.id}:app`,
    NETWORK: `${this.id}-private`,
    PG: `${this.id}-pg`,
    VOLUME: `${this.id}-volume`,
    SERVER: `${this.id}-server`,
    CADDY: `${this.id}-caddy`,
    PUBLIC_NETWORK: `${this.id}-public`,
    CONFIG_DIR: this.dir,
    PG_PASSWORD: 'fixture-secret',
    ADMIN_TOKEN: 'fixture-admin',
    TRUSTED_INGEST_TOKEN: 'fixture-ingest',
    PORT: '8181',
    HTTP_PORT: '0',
    HTTPS_PORT: '0',
    SITE: 'http://:80',
  };
  readonly containers = new Set<string>();
  async step(name: string, source = runbook) {
    return command(['sh', '-eu', '-c', block(name, source)], this.env);
  }
  async setup() {
    await docker('info');
    await docker('pull', 'postgres:16-alpine');
    await docker('pull', 'caddy:2-alpine');
    await this.step('build');
    await this.step('network');
    this.containers.add(this.env.PG as string);
    await this.step('postgres');
    await until('Postgres ready', async () => {
      try {
        await docker('exec', this.env.PG as string, 'pg_isready', '-U', 'beacon', '-d', 'beacon');
        return true;
      } catch {
        return false;
      }
    });
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
      'beacon',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      query,
    );
  }
  async launch(name = this.env.SERVER as string, options: string[] = []) {
    this.containers.add(name);
    if (options.length) {
      await docker(
        'run',
        '-d',
        '--name',
        name,
        '--network',
        this.env.NETWORK as string,
        '--env-file',
        join(this.dir, 'beacon.env'),
        '-p',
        `127.0.0.1::${this.env.PORT}`,
        ...options,
        this.env.IMAGE as string,
      );
    } else await command(['sh', '-eu', '-c', block('launch')], { ...this.env, SERVER: name });
    const port = await docker('port', name, `${this.env.PORT}/tcp`);
    const url = `http://${port}`;
    await until(`${name} HTTP ready`, async () => {
      try {
        return (await fetch(`${url}/health`)).ok;
      } catch {
        return false;
      }
    });
    return url;
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
    for (const network of [this.env.NETWORK, this.env.PUBLIC_NETWORK]) {
      try {
        await docker('network', 'rm', network as string);
      } catch {
        /* setup may fail before creation */
      }
    }
    try {
      await docker('volume', 'rm', this.env.VOLUME as string);
    } catch {
      /* setup may fail before creation */
    }
    try {
      await docker('image', 'rm', this.env.IMAGE as string);
    } catch {
      /* setup may fail before creation */
    }
    rmSync(this.dir, { recursive: true, force: true });
  }
  preload(contents: string) {
    const path = join(this.dir, 'timing.ts');
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
