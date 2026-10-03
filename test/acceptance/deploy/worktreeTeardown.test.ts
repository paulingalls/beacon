import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checked,
  command,
  configured,
  install,
  observe,
  preserveError,
  primary,
  project,
  replace,
  root,
  scriptPath,
  shim,
  source,
  withFixture,
} from './worktreeTeardown.fixture';

test('primary checkout and Git discovery refuse before Docker', () => {
  withFixture((f) => {
    const receipt = join(f.dir, 'docker-called');
    const env = shim(f.dir, 'docker', `echo "$*" >> '${receipt}'\nexit 0`);
    const cwd = primary(f.dir);
    const assertRefusal = () => {
      const result = command(configured(cwd), cwd, env);
      expect(existsSync(receipt), 'no Docker call from primary').toBe(false);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('primary checkout');
    };
    assertRefusal();
    install(cwd, replace(source(), '[ "$git_dir" = "$common_dir" ]', '[ false = true ]'));
    observe('primary-guard-bypass', assertRefusal, 'no Docker call from primary');
    rmSync(receipt, { force: true });
    const result = command([join(f.cwd, scriptPath)], f.dir, env);
    expect(result.status, 'non-Git invocation refused').not.toBe(0);
    expect(result.stderr).toContain('not a git repository');
    expect(existsSync(receipt), 'no Docker call outside Git').toBe(false);
    const realGit = checked(['which', 'git'], root);
    for (const [name, flag] of [
      ['git-root-swallowed', '--show-toplevel'],
      ['git-dir-swallowed', '--absolute-git-dir'],
      ['git-common-swallowed', '--git-common-dir'],
    ] as const) {
      const value = checked(['git', 'rev-parse', '--path-format=absolute', flag], f.cwd);
      const gitEnv = shim(
        f.dir,
        'git',
        `case "$*" in\n  *${flag}*) echo '${value}'; echo discovery-failed >&2; exit 43;;\nesac\nexec '${realGit}' "$@"`,
      );
      const assertion = () => {
        const actual = command(configured(f.cwd), f.cwd, gitEnv);
        expect(actual.status, 'Git discovery failure stays loud').toBe(43);
        expect(actual.stderr).toContain('discovery-failed');
        expect(existsSync(receipt), 'no Docker after Git failure').toBe(false);
      };
      assertion();
      const line = source()
        .split('\n')
        .find((line) => line.includes(flag)) as string;
      install(f.cwd, replace(source(), line, `${line} || true`));
      observe(name, assertion, 'Git discovery failure stays loud');
      install(f.cwd);
      rmSync(receipt, { force: true });
    }
  });
}, 60000);

test('Docker failures propagate and stop teardown; setup failures are checked', () => {
  withFixture((f) => {
    const receipt = join(f.dir, 'calls');
    for (const stage of ['rm', 'down'] as const) {
      const env = shim(
        f.dir,
        'docker',
        `echo "$*" >> '${receipt}'\nif [ "$2" = '${stage}' ]; then echo ${stage}-failed >&2; exit 47; fi`,
      );
      const assertion = () => {
        rmSync(receipt, { force: true });
        const result = command(configured(f.cwd), f.cwd, env);
        expect(result.status, `${stage} failure stays loud`).toBe(47);
        expect(result.stderr).toContain(`${stage}-failed`);
        expect(readFileSync(receipt, 'utf8').trim().split('\n')).toEqual(
          stage === 'rm' ? ['compose rm -fsv'] : ['compose rm -fsv', 'compose down'],
        );
      };
      assertion();
      const line = `docker compose ${stage === 'rm' ? 'rm -fsv' : 'down'}`;
      install(f.cwd, replace(source(), line, `${line} || true`));
      observe(`${stage}-failure-swallowed`, assertion, `${stage} failure stays loud`);
      install(f.cwd);
    }
    const env = shim(f.dir, 'docker', 'echo setup-failed >&2\nexit 49');
    for (const argv of [
      ['docker', 'info'],
      ['docker', 'compose', 'up', '-d', '--wait'],
    ]) {
      const assertion = (swallow = false) =>
        expect(() => checked(argv, f.cwd, env, swallow), 'setup failure stays loud').toThrow(
          'setup-failed',
        );
      assertion();
      observe('setup-failure-swallowed', () => assertion(true), 'setup failure stays loud');
    }
    for (const [name, argv, options, message] of [
      ['spawn-error-swallowed', ['/missing/teardown-executable'], {}, 'ENOENT'],
      ['signal-swallowed', ['sh', '-c', 'kill -TERM $$'], {}, 'SIGTERM'],
      ['timeout-swallowed', ['sh', '-c', 'sleep 1'], { timeout: 10 }, 'ETIMEDOUT'],
    ] as const) {
      const assertion = (swallow?: 'error' | 'signal') =>
        expect(
          () => command([...argv], f.cwd, process.env, { ...options, swallow }),
          `${name} stays loud`,
        ).toThrow(message);
      assertion();
      observe(
        name,
        () => assertion(name === 'signal-swallowed' ? 'signal' : 'error'),
        `${name} stays loud`,
      );
    }
  });
}, 60000);

test('shipped teardown removes only owned anonymous volumes across two cycles', () => {
  withFixture((f) => {
    const overlay = join(f.dir, 'control.yml');
    writeFileSync(
      overlay,
      'services:\n  postgres:\n    volumes:\n      - control:/control\nvolumes:\n  control:\n',
    );
    const owned = project(f.cwd, overlay);
    const unrelated = project(f.cwd, overlay);
    preserveError(
      () => {
        const named = `${owned.name}_control`;
        const assertAnonymousAbsent = (volume: string) =>
          expect(owned.inventory('volume'), 'owned anonymous volume absent').not.toContain(volume);
        const assertNamedPresent = () =>
          expect(owned.inventory('volume'), 'named volume survives').toContain(named);
        const other = unrelated.start();
        const assertUnrelated = () => {
          expect(unrelated.containers(), 'unrelated container survives').toEqual([other.id]);
          expect(
            JSON.parse(unrelated.docker('inspect', other.id))[0].State.Running,
            'unrelated running',
          ).toBe(true);
          expect(unrelated.inventory('volume'), 'unrelated volume survives').toContain(
            other.volume,
          );
        };
        for (let cycle = 0; cycle < 2; cycle++) {
          const { volume } = owned.start();
          expect(owned.inventory('volume')).toContain(named);
          assertUnrelated();
          checked(configured(f.cwd), f.cwd, owned.env);
          assertAnonymousAbsent(volume);
          expect(owned.containers()).toEqual([]);
          expect(owned.inventory('network')).not.toContain(`${owned.name}_default`);
          assertNamedPresent();
          assertUnrelated();
        }
        checked(configured(f.cwd), f.cwd, owned.env);
        for (const name of ['no-volume-removal', 'named-volume-removal', 'unrelated-removal']) {
          const { volume } = owned.start();
          let mutant = source();
          if (name === 'no-volume-removal') mutant = replace(mutant, 'rm -fsv', 'rm -fs');
          if (name === 'named-volume-removal')
            mutant = replace(mutant, 'docker compose down', 'docker compose down -v');
          if (name === 'unrelated-removal') mutant += `\ndocker rm -f '${other.id}'\n`;
          install(f.cwd, mutant);
          checked(configured(f.cwd), f.cwd, owned.env);
          const assertion = () => {
            if (name === 'no-volume-removal') assertAnonymousAbsent(volume);
            if (name === 'named-volume-removal') assertNamedPresent();
            assertUnrelated();
          };
          observe(
            name,
            assertion,
            name === 'no-volume-removal'
              ? 'owned anonymous volume absent'
              : name === 'named-volume-removal'
                ? 'named volume survives'
                : 'unrelated container survives',
          );
          install(f.cwd);
        }
      },
      () =>
        preserveError(
          () => owned.cleanup(),
          () => unrelated.cleanup(),
        ),
    );
  });
}, 180000);

test('live disposable primary database survives refusal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'beacon-primary-'));
  preserveError(
    () => {
      const cwd = primary(dir);
      const overlay = join(dir, 'control.yml');
      writeFileSync(overlay, 'services: {}\n');
      const control = project(cwd, overlay);
      preserveError(
        () => {
          const { id, volume } = control.start();
          const result = command(configured(cwd), cwd, control.env);
          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain('primary checkout');
          expect(control.containers()).toEqual([id]);
          expect(control.inventory('volume')).toContain(volume);
          expect(JSON.parse(control.docker('inspect', id))[0].State.Running).toBe(true);
        },
        () => control.cleanup(),
      );
    },
    () => rmSync(dir, { recursive: true }),
  );
}, 60000);
