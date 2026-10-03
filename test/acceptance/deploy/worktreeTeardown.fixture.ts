import { expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const root = resolve(import.meta.dir, '../../..');
export const scriptPath = 'scripts/teardown-worktree.sh';
export const source = () => readFileSync(join(root, scriptPath), 'utf8');
const compose = readFileSync(join(root, 'docker-compose.yml'), 'utf8');
const faults = [
  'no-volume-removal',
  'named-volume-removal',
  'unrelated-removal',
  'primary-guard-bypass',
  'rm-failure-swallowed',
  'down-failure-swallowed',
  'setup-failure-swallowed',
  'git-root-swallowed',
  'git-dir-swallowed',
  'git-common-swallowed',
  'spawn-error-swallowed',
  'signal-swallowed',
  'timeout-swallowed',
];
const selected = process.env.BEACON_WORKTREE_TEARDOWN_FAULT;
if (selected && !faults.includes(selected)) throw new Error(`Unknown teardown fault: ${selected}`);
export function command(
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  options: { timeout?: number; swallow?: 'error' | 'signal' } = {},
) {
  const result = spawnSync(argv[0] as string, argv.slice(1), {
    cwd,
    env,
    encoding: 'utf8',
    timeout: options.timeout ?? 60000,
  });
  if (result.error && options.swallow !== 'error') throw result.error;
  if (result.signal && options.swallow !== 'signal')
    throw new Error(`${argv.join(' ')}: signal ${result.signal}`);
  return result;
}
export function checked(argv: string[], cwd: string, env?: NodeJS.ProcessEnv, swallow = false) {
  const result = command(argv, cwd, env);
  if (!swallow) expect(result.status, `${argv.join(' ')}\n${result.stderr}`).toBe(0);
  return result.stdout.trim();
}
export function replace(text: string, before: string, after: string) {
  expect(text).toContain(before);
  return text.replace(before, after);
}
export function observe(name: string, check: () => void, boundary: string) {
  if (selected === name) return check();
  let failure: unknown;
  try {
    check();
  } catch (error) {
    failure = error;
  }
  expect(String(failure), `mutation ${name} must red at ${boundary}`).toContain(boundary);
  console.log(`observed red: ${name} (${boundary})`);
}
export function configured(cwd: string) {
  const lines = readFileSync(join(cwd, '.xp/system.md'), 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('**Worktree teardown**:'));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(/^\*\*Worktree teardown\*\*: `[^`]+`$/);
  const argv = (lines[0] as string).split('`')[1]?.split(' ') as string[];
  expect(argv).toEqual([`./${scriptPath}`]);
  expect(statSync(join(cwd, argv[0] as string)).mode & 0o111).not.toBe(0);
  return argv;
}
export function install(cwd: string, text = source()) {
  mkdirSync(join(cwd, 'scripts'), { recursive: true });
  mkdirSync(join(cwd, '.xp'), { recursive: true });
  writeFileSync(join(cwd, scriptPath), text);
  chmodSync(join(cwd, scriptPath), 0o755);
  writeFileSync(join(cwd, '.xp/system.md'), readFileSync(join(root, '.xp/system.md')));
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'beacon-teardown-'));
  const cwd = join(dir, 'linked');
  try {
    checked(['git', 'worktree', 'add', '--detach', cwd, 'HEAD'], root);
    install(cwd);
    expect(readFileSync(join(cwd, 'docker-compose.yml'), 'utf8')).toBe(compose);
  } catch (error) {
    preserveError(
      () => {
        throw error;
      },
      () => {
        if (existsSync(cwd)) checked(['git', 'worktree', 'remove', '--force', cwd], root);
        rmSync(dir, { recursive: true, force: true });
      },
    );
    throw error;
  }
  return {
    dir,
    cwd,
    close() {
      checked(['git', 'worktree', 'remove', '--force', cwd], root);
      rmSync(dir, { recursive: true });
    },
  };
}
export function shim(dir: string, name: string, text: string) {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, name), `#!/bin/sh\n${text}\n`);
  chmodSync(join(bin, name), 0o755);
  return { ...process.env, PATH: `${bin}:${process.env.PATH}` };
}
export function primary(dir: string) {
  const cwd = join(dir, 'primary');
  mkdirSync(cwd);
  checked(['git', 'init', cwd], dir);
  writeFileSync(join(cwd, 'docker-compose.yml'), compose);
  install(cwd);
  checked(['git', 'add', '.'], cwd);
  checked(
    [
      'git',
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-m',
      'fixture',
    ],
    cwd,
  );
  return cwd;
}
export function preserveError(body: () => void, cleanup: () => void) {
  const errors: unknown[] = [];
  try {
    body();
  } catch (error) {
    errors.push(error);
  }
  try {
    cleanup();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, 'teardown test and cleanup failed');
}

export function project(cwd: string, overlay: string) {
  const name = `beacon-teardown-${crypto.randomUUID()}`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    COMPOSE_PROJECT_NAME: name,
    COMPOSE_FILE: `${join(cwd, 'docker-compose.yml')}:${overlay}`,
    BEACON_PG_PORT: '0',
  };
  delete env.COMPOSE_PROJECT_DIRECTORY;
  delete env.COMPOSE_PATH_SEPARATOR;
  const volumes = new Set<string>();
  const docker = (...args: string[]) => checked(['docker', ...args], cwd, env);
  const inventory = (kind: 'volume' | 'network') =>
    docker(kind, 'ls', '--format', '{{.Name}}').split('\n');
  const containers = () =>
    docker('ps', '-aq', '--no-trunc', '--filter', `label=com.docker.compose.project=${name}`)
      .split('\n')
      .filter(Boolean);
  const capture = () => {
    for (const id of containers()) {
      const mounts = JSON.parse(docker('inspect', id))[0].Mounts as {
        Type: string;
        Name: string;
        Destination: string;
      }[];
      for (const mount of mounts) if (mount.Type === 'volume') volumes.add(mount.Name);
    }
  };
  return {
    name,
    env,
    docker,
    inventory,
    containers,
    start() {
      docker('info');
      docker('compose', 'up', '-d', '--wait', '--wait-timeout', '30');
      capture();
      const id = docker('compose', 'ps', '-q', 'postgres');
      const inspected = JSON.parse(docker('inspect', id))[0];
      expect(inspected.Config.Labels['com.docker.compose.project']).toBe(name);
      expect(
        JSON.parse(docker('network', 'inspect', `${name}_default`))[0].Labels[
          'com.docker.compose.project'
        ],
      ).toBe(name);
      expect(Number(inspected.NetworkSettings.Ports['5432/tcp'][0].HostPort)).toBeGreaterThan(0);
      const volume = inspected.Mounts.find(
        (mount: { Destination: string }) => mount.Destination === '/var/lib/postgresql/data',
      )?.Name as string;
      expect(volume).toBeTruthy();
      expect(inventory('volume')).toContain(volume);
      return { id, volume };
    },
    cleanup() {
      capture();
      docker('compose', 'down');
      const existing = inventory('volume');
      for (const volume of volumes) if (existing.includes(volume)) docker('volume', 'rm', volume);
    },
  };
}

export function withFixture(body: (f: ReturnType<typeof fixture>) => void) {
  const f = fixture();
  preserveError(
    () => body(f),
    () => f.close(),
  );
}
