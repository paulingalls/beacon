import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const names = [
  'Packages',
  'Config',
  'Keys',
  'Accounts',
  'Sudoers',
  'SUID/SGID',
  'Units',
  'Loader',
  'Processes',
  'Checkout',
  'Bun',
];
export async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'beacon-integrity-')));
  const env = { ...process.env };
  for (const key of (await Bun.$`git rev-parse --local-env-vars`.text()).trim().split('\n'))
    Reflect.deleteProperty(env, key);
  const put = (path: string, text: string, mode = 0o644) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text, { mode });
    chmodSync(join(root, path), mode);
  };
  const command = (args: string[], cwd = root) => {
    const p = Bun.spawnSync(args, { cwd, env });
    if (p.exitCode) throw new Error(p.stderr.toString());
    return p.stdout.toString().trim();
  };
  for (const dir of [
    'proc/1',
    'etc/systemd/system/timers.target.wants',
    'usr/lib/systemd/system',
    'bin',
    'cache',
    'app',
    'policy',
  ])
    mkdirSync(join(root, dir), { recursive: true });
  put('proc/1/status', 'Kthread: 1\n');
  put('proc/cpuinfo', 'flags : avx2\n');
  put('verify', '??5?????? c /etc/default/motd-news\n');
  put(
    'passwd',
    'root:x:0:0::/root:/bin/bash\nbeacon:x:1000:1000::/home/beacon:/bin/bash\npaul:x:1001:1001::/home/paul:/bin/bash\nsync:x:4:65534::/bin:/bin/sync\nnobody:x:65534:65534::/:/usr/sbin/nologin\n',
  );
  put('etc/caddy/Caddyfile', 'expected\n');
  put('policy/Caddyfile', 'expected\n');
  for (const [name, rule] of Object.entries({
    beacon:
      'beacon ALL=(root) NOPASSWD: /usr/bin/systemctl restart beacon, /usr/bin/systemctl restart beacon.service',
    paul: 'paul ALL=(ALL) NOPASSWD:ALL',
    '90-cloud-init-users': 'root ALL=(ALL) NOPASSWD:ALL',
    README: '',
  }))
    put(`etc/sudoers.d/${name}`, `# comment\n${rule}\n`);
  command(['ssh-keygen', '-qt', 'ed25519', '-N', '', '-f', join(root, 'key')]);
  command(['ssh-keygen', '-qt', 'ed25519', '-N', '', '-f', join(root, 'extra')]);
  put('home/paul/.ssh/authorized_keys', readFileSync(join(root, 'key.pub'), 'utf8'));
  const fingerprint = command(['ssh-keygen', '-lf', join(root, 'key.pub'), '-E', 'sha256']).split(
    ' ',
  )[1];
  const policy = JSON.parse(readFileSync('deploy/integrity-allowlist', 'utf8'));
  policy.keys.paul = [fingerprint];
  put('policy/allowlist', JSON.stringify(policy));
  put('usr/lib/systemd/system/owned.service', 'package unit\n');
  put('etc/systemd/system/beacon.service', 'local unit\n');
  symlinkSync(
    '../../../usr/lib/systemd/system/owned.service',
    join(root, 'etc/systemd/system/owned-alias.service'),
  );
  symlinkSync(
    '../beacon.service',
    join(root, 'etc/systemd/system/timers.target.wants/beacon.service'),
  );
  put('usr/bin/owned', 'binary', 0o4755);
  put('owned', '/lib/systemd/system/owned.service\n/usr/bin/owned\n');
  put(
    'bin/dpkg',
    `#!/usr/bin/env python3
import os, sys, fnmatch
from pathlib import Path
r=Path(os.environ['INTEGRITY_ROOT'])
if sys.argv[1]=='--verify':
 print((r/'verify').read_text(),end=''); sys.exit(2 if (r/'dpkg-error').exists() else 0)
# dpkg treats each query as a glob, including leading-slash arguments.
p=sys.argv[2].replace('\\\\[','[[]').replace('\\\\*','[*]').replace('\\\\?','[?]')
sys.exit(0 if any(fnmatch.fnmatchcase(x,p) for x in (r/'owned').read_text().splitlines()) else 1)
`,
    0o755,
  );
  put('bin/uname', '#!/bin/bash\necho x86_64\n', 0o755);
  put('bin/getent', '#!/bin/bash\ncat "$INTEGRITY_ROOT/passwd"\n', 0o755);
  put('bin/visudo', '#!/bin/bash\nexit 0\n', 0o755);
  command(['git', 'init', '-qb', 'main', 'app']);
  command(['git', 'config', 'user.email', 'test@test'], join(root, 'app'));
  command(['git', 'config', 'user.name', 'test'], join(root, 'app'));
  put('app/.bun-version', '1.4.4\n');
  command(['git', 'add', '.'], join(root, 'app'));
  command(['git', 'commit', '-qm', 'baseline'], join(root, 'app'));
  command(['git', 'update-ref', 'refs/remotes/origin/release', 'HEAD'], join(root, 'app'));
  put('lock', '');
  put('asset/bun-linux-x64/bun', 'official binary');
  put('bun', 'official binary');
  command(['zip', '-qr', 'bun-linux-x64.zip', 'bun-linux-x64'], join(root, 'asset'));
  const archive = readFileSync(join(root, 'asset/bun-linux-x64.zip'));
  const digest = new Bun.CryptoHasher('sha256').update(archive).digest('hex');
  const alerts: Array<{ subject: string; text: string }> = [];
  let downloads = 0;
  let responseStatus = 200;
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      if (new URL(req.url).pathname === '/emails') {
        alerts.push((await req.json()) as { subject: string; text: string });
        return Response.json(
          responseStatus === 200 ? { id: 'test-message' } : { error: 'rejected' },
          { status: responseStatus },
        );
      }
      downloads++;
      return new URL(req.url).pathname.endsWith('SHASUMS256.txt')
        ? new Response(`${digest}  bun-linux-x64.zip\n`)
        : new Response(archive);
    },
  });
  put(
    'alert.env',
    'RESEND_API_KEY=fixture-token\nALERT_FROM=alerts@example.test\nALERT_TO=paul@example.test\n',
    0o600,
  );
  Object.assign(env, {
    PATH: `${root}/bin:/opt/homebrew/opt/coreutils/libexec/gnubin:${env.PATH}`,
    INTEGRITY_ROOT: root,
    INTEGRITY_APP: `${root}/app`,
    INTEGRITY_POLICY: `${root}/policy`,
    INTEGRITY_CACHE: `${root}/cache`,
    INTEGRITY_LOCK: `${root}/lock`,
    INTEGRITY_BUN: `${root}/bun`,
    INTEGRITY_ALERT_ENV: `${root}/alert.env`,
    INTEGRITY_RELEASE_BASE: `${server.url}bun-v`,
    INTEGRITY_ALERT_BASE: String(server.url).replace(/\/$/, ''),
  });
  return {
    root,
    put,
    command,
    alerts,
    downloads: () => downloads,
    reject: () => {
      responseStatus = 422;
    },
    async run() {
      const p = Bun.spawn(['bash', 'deploy/beacon-integrity.sh'], {
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ]);
      return { code, output: stdout + stderr };
    },
    close() {
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
