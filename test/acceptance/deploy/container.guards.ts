import { expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { block, type ContainerFixture, docker, root, runbook, until } from './container.fixture';

export function launchTopology(source = runbook) {
  expect(block('launch', source)).not.toMatch(/\s-p\s/);
  expect(block('caddy-launch', source)).toContain('--network "$PUBLIC_NETWORK"');
  expect(block('caddy-launch', source)).toContain('docker network connect "$NETWORK"');
}
export const subprocesses = [
  'test/acceptance/ci/release-artifacts.roundtrip.test.ts',
  'test/acceptance/deploy/rollback.test.ts',
  'test/acceptance/deploy/readerRole.test.ts',
  'apps/server/test/router.e2e.test.ts',
  'test/acceptance/ci/file-size-cap.test.ts',
  'test/acceptance/ipMode.roundtrip.acceptance.test.ts',
  'test/acceptance/erasure.roundtrip.acceptance.test.ts',
  'test/acceptance/deploy/container.test.ts',
];
export function registration(scripts: Record<string, string>) {
  for (const path of subprocesses) {
    expect(scripts['test:story']?.split(`--path-ignore-patterns=${path}`).length).toBe(2);
    expect(scripts['test:slow']?.split(`./${path}`).length).toBe(2);
  }
}
export const guidance = [
  'IP_MODE=none',
  'REFERRER_MODE=origin-and-path',
  'RETENTION_DAYS=30',
  'Re-resolve',
  'hostname-only',
  'browser-side',
  'cdn.jsdelivr.net/npm/chart.js',
  'failed/swallowed',
  '0.0.0.0:65535',
  '[::]:65535',
  'Postgres-IP:0',
  'no send',
  'missing Docker/tracing',
  'reader-role',
  'DATABASE_URL',
];
export function documentation(source: string) {
  launchTopology(source);
  for (const word of guidance) expect(source).toContain(word);
}
export async function inspect(name: string) {
  return JSON.parse(await docker('inspect', name))[0];
}
export async function isolated(f: ContainerFixture) {
  for (const name of [f.env.SERVER, f.env.PG]) {
    const config = await inspect(name as string);
    expect(Object.keys(config.NetworkSettings.Networks)).toEqual([f.env.NETWORK as string]);
    expect(Object.values(config.NetworkSettings.Ports).every((value) => value === null)).toBe(true);
    expect(Object.keys(config.HostConfig.PortBindings ?? {})).toEqual([]);
  }
  const gateway = await inspect(f.env.CADDY as string);
  expect(gateway.HostConfig.NetworkMode).toBe(f.env.PUBLIC_NETWORK);
  expect(Object.keys(gateway.NetworkSettings.Networks).sort()).toEqual(
    [f.env.NETWORK, f.env.PUBLIC_NETWORK].sort(),
  );
  expect(
    await docker('network', 'inspect', '--format', '{{.Internal}}', f.env.NETWORK as string),
  ).toBe('true');
  expect(
    await docker('network', 'inspect', '--format', '{{.Internal}}', f.env.PUBLIC_NETWORK as string),
  ).toBe('false');
}
export async function persisted(f: ContainerFixture, marker: string) {
  expect(
    await f.sql(
      `SELECT count(*) FROM beacon_events WHERE event_type='${marker}' AND user_id='container-user'`,
    ),
  ).toBe('1');
}
export async function query(url: string, marker: string) {
  for (const path of ['events', 'dashboard']) {
    expect((await fetch(`${url}/analytics/${path}`)).status).toBe(403);
  }
  const response = await fetch(`${url}/analytics/events?product_id=container`, {
    headers: { authorization: 'Bearer fixture-admin' },
    signal: AbortSignal.timeout(15000),
  });
  expect(response.status).toBe(200);
  expect(await response.text()).toContain(marker);
}
export async function health(f: ContainerFixture) {
  await until(
    'Docker healthy',
    async () => (await inspect(f.env.SERVER as string)).State.Health?.Status === 'healthy',
  );
}
export async function parity(
  f: ContainerFixture,
  ordinary: { env: string[]; source: string; cmd: string[]; image: string },
) {
  const actual = await inspect(f.env.SERVER as string);
  expect(actual.Image).toBe(ordinary.image);
  expect(actual.Config.Env).toEqual(ordinary.env);
  expect(actual.Config.Cmd.slice(-ordinary.cmd.length)).toEqual(ordinary.cmd);
  expect(
    await docker('exec', f.env.SERVER as string, 'sha256sum', '/app/apps/server/src/server.ts'),
  ).toBe(ordinary.source);
}
export async function ordinaryEvidence(f: ContainerFixture) {
  const actual = await inspect(f.env.SERVER as string);
  expect(actual.Config.Cmd).toEqual(['bun', 'run', 'apps/server/src/server.ts']);
  const source = await docker(
    'exec',
    f.env.SERVER as string,
    'sha256sum',
    '/app/apps/server/src/server.ts',
  );
  const local = new Bun.CryptoHasher('sha256')
    .update(readFileSync(`${root}/apps/server/src/server.ts`))
    .digest('hex');
  expect(source.split(' ')[0]).toBe(local);
  return {
    env: actual.Config.Env as string[],
    source,
    cmd: actual.Config.Cmd as string[],
    image: actual.Image as string,
  };
}

const start =
  '1 execve("/usr/local/bin/bun", ["bun", "run", "apps/server/src/server.ts"], []) = 0\n';
const pgConnect =
  '1 socket(AF_INET, SOCK_STREAM, IPPROTO_TCP) = 3\n1 connect(3, {sa_family=AF_INET, sin_port=htons(5432), sin_addr=inet_addr("10.0.0.2")}, 16) = -1 EINPROGRESS\n1 close(3) = 0\n';
const end = '1 exit_group(0) = ?\n1 +++ exited with 0 +++\n';
export function classifierControls(observe: (trace: string, pg: string) => unknown) {
  const envelope = (body: string) => start + pgConnect + body + end;
  const udp = (ip = '0.0.0.0', port = 65535, type = 'SOCK_DGRAM') =>
    `1 socket(AF_INET, ${type}, IPPROTO_IP) = 3\n1 connect(3, {sa_family=AF_INET, sin_port=htons(${port}), sin_addr=inet_addr("${ip}")}, 16) = 0\n`;
  const v6 =
    '1 socket(AF_INET6, SOCK_DGRAM, IPPROTO_IP) = 3\n1 connect(3, {sa_family=AF_INET6, sin6_port=htons(65535), inet_pton(AF_INET6, "::", &sin6_addr)}, 28) = 0\n';
  const probes = [udp(), udp('10.0.0.2', 0), v6];
  for (const probe of probes) {
    expect(() => observe(envelope(`${probe}1 close(3) = 0\n`), '10.0.0.2')).not.toThrow();
    for (const send of [
      'write(3, "x", 1)',
      'writev(3, [{iov_base="x",iov_len=1}], 1)',
      'sendto(3, "x", 1, 0, NULL, 0)',
      'sendmsg(3, {msg_name=NULL,msg_iov=[{iov_base="x",iov_len=1}]}, 0)',
      'sendmmsg(3, [{msg_hdr={msg_name=NULL,msg_iov=[{iov_base="x",iov_len=1}]}}], 1, 0)',
    ]) {
      expect(() =>
        observe(envelope(`${probe}1 ${send} = -1 EINVAL\n1 close(3) = 0\n`), '10.0.0.2'),
      ).toThrow(/datagram/);
    }
  }
  for (const body of [
    udp('127.0.0.11', 53),
    udp('127.0.0.1', 443, 'SOCK_STREAM'),
    udp('0.0.0.0', 65535, 'SOCK_STREAM'),
    udp('10.0.0.2', 0, 'SOCK_STREAM'),
    '1 socket(AF_INET, SOCK_RAW, IPPROTO_IP) = 3\n',
    `${udp('10.0.0.2', 5432, 'SOCK_STREAM').replace('IPPROTO_IP', 'IPPROTO_SCTP')}1 close(3) = 0\n`,
    '1 unknown_network_entry(0) = -1 EINVAL\n',
    '1 connect(3, {unknown_address=1}, 16) = -1 EINVAL\n',
    '1 socket(AF_INET, SOCK_DGRAM, IPPROTO_IP) = 3\n1 sendto(3, "x", 1, 0, {sa_family=AF_INET,sin_port=htons(53),sin_addr=inet_addr("127.0.0.11")}, 16) = -1 EINVAL\n',
    ...['setup', 'register', 'enter'].map((name) => `1 io_uring_${name}(0, NULL) = -1 EINVAL\n`),
    ...['dup(3)', 'dup2(3, 4)', 'dup3(3, 4, O_CLOEXEC)', 'fcntl(3, F_DUPFD_CLOEXEC, 4)'].map(
      (call) => `${udp()}1 ${call} = 4\n1 close(3) = 0\n1 write(4, "x", 1) = -1 EINVAL\n`,
    ),
    v6.replace('SOCK_DGRAM', 'SOCK_STREAM'),
    `${udp()}1 clone(child_stack=NULL, flags=CLONE_FILES|CLONE_VM) = 17 /* 10 in strace's PID NS */\n10 write(3, "x", 1) = 1\n`,
    `${udp()}1 close(3) = 0\n1 socket(AF_INET, SOCK_STREAM, IPPROTO_TCP) = 3\n1 connect(3, {sa_family=AF_INET,sin_port=htons(65535),sin_addr=inet_addr("0.0.0.0")}, 16) = -1 ECONNREFUSED\n`,
  ])
    expect(() => observe(envelope(body), '10.0.0.2')).toThrow();
  expect(() =>
    observe(
      start +
        pgConnect.replace(
          ' = -1 EINPROGRESS',
          ' <unfinished ...>\n1 <... connect resumed> = -1 EINPROGRESS',
        ) +
        end,
      '10.0.0.2',
    ),
  ).not.toThrow();
  for (const trace of [
    '',
    start + end,
    start + pgConnect,
    `${start}${pgConnect}1 read(3, <unfinished ...>\n${end}`,
    `${start}${pgConnect}not a trace\n${end}`,
  ]) {
    expect(() => observe(trace, '10.0.0.2')).toThrow();
  }
}

export async function red(name: string, action: () => Promise<unknown>, target: RegExp) {
  if (Bun.env.BEACON_CONTAINER_FAULT === name) {
    await action();
    return;
  }
  await expect(action()).rejects.toThrow(target);
  console.log(`observed red: ${name}`);
}

export function registrationControls() {
  const { scripts } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  registration(scripts);
  for (const path of subprocesses)
    for (const tier of ['test:story', 'test:slow']) {
      expect(() =>
        registration({ ...scripts, [tier]: scripts[tier].replace(path, 'omitted') }),
      ).toThrow();
    }
}

export async function gatewayHealth(url: string) {
  const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: 'ok' });
}
