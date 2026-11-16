import { expect, test } from 'bun:test';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const provision = await Bun.file('scripts/provision-droplet.sh').text();
test('privileged installs and scripts never use the app checkout', () => {
  const commands = provision
    .replace(/\\\n/g, ' ')
    .split('\n')
    .filter((line) => /\b(install|bash)\b/.test(line));
  expect(commands.filter((line) => /\$\{?APP_DIR\}?\/(deploy|scripts)\b/.test(line))).toEqual([]);
});
// Bun auto-loads .env files from the app checkout, and a package script's nested bun drops the flag.
test('operator bun commands in the app checkout skip .env files', async () => {
  const runbook = await Bun.file('docs/DEPLOYMENT.md').text();
  const commands = `${provision}\n${runbook}`
    .split('\n')
    .filter((line) => line.includes('.bun/bin/bun '));
  expect(
    commands.filter(
      (line) => !/bun (install )?--no-env-file /.test(line) || /run migrate\b/.test(line),
    ),
  ).toEqual([]);
});
for (const [name, mode, missing, diagnostic] of [
  ['missing asset', 0o700, true, 'Missing asset'],
  ['unsafe mode', 0o755, false, 'mode 0700'],
  ['app owner', 0o700, false, 'root-owned'],
] as const) {
  test(`provisioner refuses ${name} before mutation`, () => {
    const root = mkdtempSync(join(tmpdir(), 'beacon-provision-'));
    try {
      cpSync('scripts', join(root, 'scripts'), { recursive: true });
      cpSync('deploy', join(root, 'deploy'), { recursive: true });
      if (missing) rmSync(join(root, 'deploy/beacon.service'));
      chmodSync(root, mode);
      mkdirSync(join(root, 'bin'));
      for (const command of ['apt-get', 'install', 'curl', 'adduser', 'usermod', 'systemctl']) {
        writeFileSync(join(root, 'bin', command), `#!/bin/sh\ntouch '${root}/mutation'\nexit 1\n`, {
          mode: 0o755,
        });
      }
      const p = Bun.spawnSync(['bash', join(root, 'scripts/provision-droplet.sh')], {
        env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}` },
      });
      expect(p.exitCode).not.toBe(0);
      expect(p.stdout.toString() + p.stderr.toString()).toContain(diagnostic);
      expect(existsSync(join(root, 'mutation'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
