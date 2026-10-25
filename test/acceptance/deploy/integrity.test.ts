import { expect, test } from 'bun:test';
import { readFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, names } from './integrity.fixture';

test('eleven named verdicts, usrmerge ownership, and warm authenticated Bun cache', async () => {
  const f = await fixture();
  try {
    const cold = await f.run();
    expect(cold.code, cold.output).toBe(0);
    expect(cold.output.match(/^PASS .+:/gm)?.map((x) => x.slice(5, -1))).toEqual(names);
    expect(f.alerts).toHaveLength(0);
    expect(f.downloads()).toBe(2);
    const warm = await f.run();
    expect(warm.code, warm.output).toBe(0);
    expect(f.downloads()).toBe(2);
  } finally {
    f.close();
  }
});
const faults: Array<[string, string, (f: Awaited<ReturnType<typeof fixture>>) => void]> = [
  ['package executable', 'Packages', (f) => f.put('verify', '??5?????? /usr/bin/owned\n')],
  [
    'package helper outside bin/lib',
    'Packages',
    (f) => f.put('verify', '??5?????? /usr/libexec/sudo/sudoers.so\n'),
  ],
  ['dpkg inventory failure', 'Packages', (f) => f.put('dpkg-error', '')],
  ['Caddy config', 'Config', (f) => f.put('etc/caddy/Caddyfile', 'changed')],
  ['main sudoers', 'Config', (f) => f.put('verify', '??5?????? c /etc/sudoers\n')],
  [
    'second key file',
    'Keys',
    (f) =>
      f.put(
        'home/paul/.ssh/authorized_keys2',
        readFileSync(join(f.root, 'extra.pub'), 'utf8').trimEnd(),
      ),
  ],
  [
    'sshd key command drop-in',
    'Keys',
    (f) =>
      f.put(
        'sshd-config',
        readFileSync(join(f.root, 'sshd-config'), 'utf8').replace(
          'authorizedkeyscommand none',
          'authorizedkeyscommand /var/tmp/k',
        ),
      ),
  ],
  [
    'key for a nologin account',
    'Keys',
    (f) => f.put('.ssh/authorized_keys', readFileSync(join(f.root, 'extra.pub'), 'utf8')),
  ],
  [
    'uid zero',
    'Accounts',
    (f) =>
      f.put(
        'passwd',
        `${readFileSync(join(f.root, 'passwd'), 'utf8')}intruder:x:0:0::/root:/bin/bash\n`,
      ),
  ],
  [
    'extra sudo grant',
    'Sudoers',
    (f) => f.put('etc/sudoers.d/intruder', 'beacon ALL=(ALL) NOPASSWD:ALL\n'),
  ],
  [
    'uid rule shaped like a comment',
    'Sudoers',
    (f) => f.put('etc/sudoers.d/README', '#1000 ALL=(ALL) ALL\n'),
  ],
  [
    'legacy include directive',
    'Sudoers',
    (f) => f.put('etc/sudoers.d/README', '#includedir /tmp\n'),
  ],
  ['unowned SUID', 'SUID/SGID', (f) => f.put('usr/bin/intruder', 'bad', 0o4755)],
  ['literal dpkg wildcard', 'SUID/SGID', (f) => f.put('usr/bin/*', 'bad', 0o4755)],
  [
    'setuid added to a packaged binary',
    'SUID/SGID',
    (f) => {
      f.put('usr/bin/python3', 'packaged', 0o4755);
      f.put('owned', `${readFileSync(join(f.root, 'owned'), 'utf8')}/usr/bin/python3\n`);
    },
  ],
  ['unknown timer', 'Units', (f) => f.put('run/systemd/transient/intruder.timer', 'bad')],
  [
    'changed generated dependency link',
    'Units',
    (f) => {
      const path = join(
        f.root,
        'run/systemd/generator/multi-user.target.wants/systemd-networkd.service',
      );
      unlinkSync(path);
      symlinkSync('../intruder.service', path);
    },
  ],
  ['loader', 'Loader', (f) => f.put('etc/ld.so.preload', 'bad')],
  [
    'deleted executable',
    'Processes',
    (f) => symlinkSync('/usr/bin/deleted (deleted)', join(f.root, 'proc/1/exe')),
  ],
  ['dirty checkout', 'Checkout', (f) => f.put('app/.bun-version', '1.4.4\n\n')],
  [
    'forged local release ref',
    'Checkout',
    (f) => {
      const tree = f.command(['git', 'rev-parse', 'HEAD^{tree}'], join(f.root, 'app'));
      const sha = f.command(
        [
          'git',
          '-c',
          'user.name=test',
          '-c',
          'user.email=test@test',
          'commit-tree',
          tree,
          '-m',
          'remote release',
        ],
        join(f.root, 'remote'),
      );
      f.command(['git', 'update-ref', 'refs/heads/release', sha], join(f.root, 'remote'));
    },
  ],
  ['release transport failure', 'Checkout', (f) => f.put('remote-error', '')],
  [
    'absent release',
    'Checkout',
    (f) => {
      f.command(['git', 'update-ref', '-d', 'refs/heads/release'], join(f.root, 'remote'));
    },
  ],
  ['changed Bun', 'Bun', (f) => f.put('bun', 'changed')],
];
for (const [fault, name, inject] of faults)
  test(`alerts once for ${fault}`, async () => {
    const f = await fixture();
    try {
      inject(f);
      const r = await f.run();
      expect(r.code, r.output).not.toBe(0);
      expect(r.output).toContain(`FAIL ${name}:`);
      expect(f.alerts).toHaveLength(1);
      expect(f.alerts[0]?.text).toContain(`FAIL ${name}:`);
      expect(r.output).toContain('Alert accepted: test-message');
    } finally {
      f.close();
    }
  });
test('aborted baseline parsing still alerts once', async () => {
  const f = await fixture();
  try {
    f.put('policy/allowlist', '{invalid');
    const r = await f.run();
    expect(r.code).not.toBe(0);
    expect(f.alerts).toHaveLength(1);
    expect(f.alerts[0]?.text).toContain('runner aborted');
  } finally {
    f.close();
  }
});
test('provider rejection is explicit and never claims acceptance', async () => {
  const f = await fixture();
  try {
    f.put('etc/ld.so.preload', 'bad');
    f.reject();
    const r = await f.run();
    expect(r.code).not.toBe(0);
    expect(f.alerts).toHaveLength(1);
    expect(r.output).toContain('Alert delivery FAILED');
    expect(r.output).not.toContain('Alert accepted');
  } finally {
    f.close();
  }
});

test('TERM during a hung inventory leaves the service stop window for its alert', async () => {
  const f = await fixture();
  try {
    f.put('bin/dpkg', '#!/bin/bash\nsleep 5\n', 0o755);
    const start = Date.now();
    const r = await f.run(true);
    expect(r.code).toBe(143);
    expect(f.alerts).toHaveLength(1);
    expect(f.alerts[0]?.text).toContain('runner aborted');
    expect(Date.now() - start).toBeLessThan(2000);
  } finally {
    f.close();
  }
});

for (const group of ['sudo', 'admin']) {
  for (const primary of [false, true]) {
    test(`alerts for ${group} ${primary ? 'primary' : 'supplementary'} member`, async () => {
      const f = await fixture();
      try {
        const gid = group === 'sudo' ? 27 : 80;
        f.put(
          'group',
          `${group === 'admin' ? 'sudo:x:27:\n' : ''}${group}:x:${gid}:${primary ? '' : 'beacon'}\n`,
        );
        if (primary)
          f.put(
            'passwd',
            readFileSync(join(f.root, 'passwd'), 'utf8').replace(
              'beacon:x:1000:1000:',
              `beacon:x:1000:${gid}:`,
            ),
          );
        const result = await f.run();
        expect(result.code, result.output).not.toBe(0);
        expect(result.output).toContain('FAIL Sudoers:');
        expect(result.output).toContain(`${group} group`);
        expect(f.alerts).toHaveLength(1);
        expect(f.alerts[0]?.text).toContain(`${group} group`);
      } finally {
        f.close();
      }
    });
  }
}
test('authoritative remote succeeds despite a stale app tracking ref', async () => {
  const f = await fixture();
  try {
    f.command(['git', 'update-ref', '-d', 'refs/remotes/origin/release'], join(f.root, 'app'));
    const result = await f.run();
    expect(result.code, result.output).toBe(0);
    const args = readFileSync(join(f.root, 'ssh-args'), 'utf8');
    for (const required of [
      '-F /dev/null',
      'IdentitiesOnly=yes',
      'StrictHostKeyChecking=yes',
      `UserKnownHostsFile=${f.root}/policy/known_hosts`,
      'GlobalKnownHostsFile=/dev/null',
      '/home/beacon/.ssh/github_deploy',
      "git-upload-pack 'paulingalls/beacon.git'",
    ])
      expect(args).toContain(required);
  } finally {
    f.close();
  }
});
