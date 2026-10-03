import { expect } from 'bun:test';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ContainerFixture, docker, root, until } from './container.fixture';
import { shared } from './container.resources';

export const syscalls = '%network,%process,%desc,io_uring_setup,io_uring_register,io_uring_enter';
export class TracedServer {
  readonly observer: string;
  readonly image: string;
  pid = 0;
  constructor(readonly f: ContainerFixture) {
    this.observer = `${f.id}-observer`;
    this.image = shared.env.OBSERVER_IMAGE;
  }
  async start(options: string[] = [], override?: string[]) {
    const f = this.f;
    rmSync(join(f.dir, 'trace'), { force: true });
    writeFileSync(
      join(f.dir, 'gate.sh'),
      '#!/bin/sh\nwhile [ ! -f /tmp/beacon-observer-go ]; do sleep 0.1; done\nexec "$@"\n',
    );
    const cmd = JSON.parse(
      await docker('image', 'inspect', '--format', '{{json .Config.Cmd}}', f.env.IMAGE as string),
    );
    expect(cmd).toEqual(['bun', 'run', 'apps/server/src/server.ts']);
    await f.launch(
      ['-v', `${f.dir}:/diagnostics`, ...options],
      ['sh', '/diagnostics/gate.sh', ...(override ?? cmd)],
    );
    f.containers.add(this.observer);
    this.pid = Number(
      await docker('inspect', '--format', '{{.State.Pid}}', f.env.SERVER as string),
    );
    expect(this.pid).toBeGreaterThan(1);
    await docker(
      'run',
      '-d',
      '--name',
      this.observer,
      '--pid',
      'host',
      '--network',
      'none',
      '--cap-add',
      'SYS_PTRACE',
      '--security-opt',
      'seccomp=unconfined',
      '-v',
      `${f.dir}:/diagnostics`,
      this.image,
      'strace',
      '--decode-pids=pidns',
      '-f',
      '-s',
      '512',
      '-v',
      '-yy',
      '-e',
      `trace=${syscalls}`,
      '-o',
      '/diagnostics/trace',
      '-p',
      String(this.pid),
    );
    await until('strace attached before exec', async () => {
      const status = await docker('exec', this.observer, 'cat', `/proc/${this.pid}/status`);
      return /TracerPid:\s+[1-9]/.test(status);
    });
    await docker('exec', f.env.SERVER as string, 'touch', '/tmp/beacon-observer-go');
  }
  async finish() {
    await this.f.stop();
    await until(
      'observer complete',
      async () =>
        (await docker('inspect', '--format', '{{.State.Status}}', this.observer)) === 'exited',
    );
    expect(await docker('inspect', '--format', '{{.State.ExitCode}}', this.observer)).toBe('0');
    const trace = readFileSync(join(this.f.dir, 'trace'), 'utf8').replace(
      new RegExp(`^${this.pid}\\s+`, 'gm'),
      '1 ',
    );
    expect(trace).toMatch(/execve\(".*bun"/);
    expect(trace).toContain('+++ exited with 0 +++');
    return trace;
  }
  async reset() {
    await this.f.reset();
    if (this.f.containers.has(this.observer)) {
      await docker('rm', '-f', this.observer);
      this.f.containers.delete(this.observer);
    }
  }
  async cleanup() {
    await this.reset();
  }
}

export function serverMutation(f: ContainerFixture, from: string, to: string) {
  const source = readFileSync(join(root, 'apps/server/src/server.ts'), 'utf8');
  if (source.split(from).length !== 2) throw new Error('source mutation must match exactly once');
  const path = join(f.dir, 'server.ts');
  writeFileSync(path, source.replace(from, to));
  return ['-v', `${path}:/app/apps/server/src/server.ts:ro`];
}
