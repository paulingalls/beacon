import { expect, test } from 'bun:test';
import { readFileSync, symlinkSync } from 'node:fs';
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
  ['dpkg inventory failure', 'Packages', (f) => f.put('dpkg-error', '')],
  ['Caddy config', 'Config', (f) => f.put('etc/caddy/Caddyfile', 'changed')],
  ['main sudoers', 'Config', (f) => f.put('verify', '??5?????? c /etc/sudoers\n')],
  [
    'second key file',
    'Keys',
    (f) =>
      f.put('home/paul/.ssh/authorized_keys2', readFileSync(join(f.root, 'extra.pub'), 'utf8')),
  ],
  [
    'uid zero',
    'Accounts',
    (f) =>
      f.put(
        'passwd',
        readFileSync(join(f.root, 'passwd'), 'utf8') + 'intruder:x:0:0::/root:/bin/bash\n',
      ),
  ],
  [
    'extra sudo grant',
    'Sudoers',
    (f) => f.put('etc/sudoers.d/intruder', 'beacon ALL=(ALL) NOPASSWD:ALL\n'),
  ],
  ['unowned SUID', 'SUID/SGID', (f) => f.put('usr/bin/intruder', 'bad', 0o4755)],
  ['literal dpkg wildcard', 'SUID/SGID', (f) => f.put('usr/bin/*', 'bad', 0o4755)],
  ['unknown timer', 'Units', (f) => f.put('etc/systemd/system/intruder.timer', 'bad')],
  ['loader', 'Loader', (f) => f.put('etc/ld.so.preload', 'bad')],
  [
    'deleted executable',
    'Processes',
    (f) => symlinkSync('/usr/bin/deleted (deleted)', join(f.root, 'proc/1/exe')),
  ],
  ['dirty checkout', 'Checkout', (f) => f.put('app/.bun-version', '1.4.4\n\n')],
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
