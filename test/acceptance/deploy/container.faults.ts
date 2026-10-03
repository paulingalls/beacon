import { expect } from 'bun:test';
import { join } from 'node:path';
import { workload } from './container.checks';
import { type ContainerFixture, docker } from './container.fixture';
import { ordinaryEvidence, parity, red } from './container.guards';
import { observe } from './container.observer';
import { shared } from './container.resources';
import { serverMutation, TracedServer } from './container.trace';

export const probeSource = `
#include <arpa/inet.h>
#include <fcntl.h>
#include <pthread.h>
int probe(int kind, const char *pg);
void *thread_probe(void *pg) { probe(1,pg); return 0; }
#include <sys/socket.h>
#include <sys/syscall.h>
#include <unistd.h>
int probe(int kind, const char *pg) {
  if (kind==9) { pthread_t thread; pthread_create(&thread,0,thread_probe,(void*)pg); pthread_join(thread,0); return 0; }
  if (kind==8) return syscall(SYS_io_uring_setup,0,0);
  int udp=kind==2||kind==3||kind==4||kind==7;
  int fd=socket(kind==3?AF_INET6:AF_INET, (udp?SOCK_DGRAM:SOCK_STREAM)|SOCK_NONBLOCK,0);
  if(kind==3) {
    struct sockaddr_in6 addr={.sin6_family=AF_INET6,.sin6_port=htons(65535)};
    connect(fd,(void*)&addr,sizeof(addr));
  } else {
    struct sockaddr_in addr={.sin_family=AF_INET,.sin_port=htons(kind==4?0:kind==7?53:kind==2||kind==5?65535:443)};
    inet_pton(AF_INET,kind==4?pg:kind==2||kind==5?"0.0.0.0":kind==6?"127.0.0.1":kind==7?"127.0.0.11":"203.0.113.99",&addr.sin_addr);
    connect(fd,(void*)&addr,sizeof(addr));
  }
  if(udp) send(fd,"x",1,0);
  close(fd);
  return 0;
}`;
export const liveFaults = [
  'swallowed-connect',
  'probe-v4-send',
  'probe-v6-send',
  'probe-pg-zero-send',
  'tcp-probe-lookalike',
  'loopback-connect',
  'dns-send',
  'unhandled-io-uring',
  'thread-swallowed-connect',
];
export function validateFault() {
  const selected = Bun.env.BEACON_CONTAINER_FAULT;
  const supported = [
    ...liveFaults,
    ...'reused-database database-cleanup-missing docker-unavailable migration-command missing-sql postgres-unavailable trusted-token-unset admin-gate-bypass egress-network beacon-published caddy-private-missing caddy-internal-first caddy-wrong-upstream missing-healthcheck bad-health-path hardcoded-health-port health-needs-db ip-mode-unset referrer-mode-unset retention-unset retention-zero retention-overbroad missing-drain nonzero-exit eager-persistence observer-missing observer-detached trace-truncated trace-unparsed calibration-missing trace-env-mismatch trace-command-mismatch trace-source-mismatch hostname-url'.split(
      ' ',
    ),
  ];
  if (selected && !supported.includes(selected))
    throw new Error(`unknown container fault: ${selected}`);
}
export async function buildProbe(tracer: TracedServer) {
  await shared.observer(probeSource, join(tracer.f.dir, 'probe.so'));
}
export function injectProbe(f: ContainerFixture, fault: string) {
  const code = liveFaults.indexOf(fault) + 1;
  if (!code) throw new Error(`unknown network fault: ${fault}`);
  return serverMutation(
    f,
    'const { app, beacon } = buildServer(process.env as ServerEnv);',
    `
    const {dlopen} = await import('bun:ffi');
    const diagnostic = dlopen('/diagnostics/probe.so', {probe:{args:['i32','ptr'],returns:'i32'}});
    diagnostic.symbols.probe(${code}, Buffer.from('${f.env.PG_IP}\\0'));
    const { app, beacon } = buildServer(process.env as ServerEnv);`,
  );
}
export async function traceFault(
  f: ContainerFixture,
  tracer: TracedServer,
  url: string,
  fault: string,
) {
  await tracer.start(injectProbe(f, fault));
  await workload(f, url, fault);
  const trace = await tracer.finish();
  const target =
    fault === 'unhandled-io-uring'
      ? /unsupported io_uring/
      : fault.startsWith('probe-') || fault === 'dns-send'
        ? /datagram|UDP association/
        : /forbidden TCP/;
  if (Bun.env.BEACON_CONTAINER_FAULT === fault) observe(trace, f.env.PG_IP as string);
  else expect(() => observe(trace, f.env.PG_IP as string)).toThrow(target);
  console.log(`observed red: ${fault}`);
}

export async function outbound(f: ContainerFixture) {
  const tracer = new TracedServer(f);
  try {
    await buildProbe(tracer);
    const url = await f.gateway();
    await f.launch();
    await workload(f, url, 'ordinary');
    const evidence = await ordinaryEvidence(f);
    await f.stop();
    await f.reset();
    await tracer.start();
    await f.ready(url);
    await parity(f, evidence);
    await workload(f, url, 'primary-trace');
    const trace = await tracer.finish();
    const counts = observe(trace, f.env.PG_IP as string);
    console.log('primary trace', JSON.stringify(counts));
    expect(counts.pgAttempts).toBeGreaterThan(0);
    for (const [fault, broken] of [
      ['observer-missing', ''],
      ['trace-truncated', trace.replace(/1\s+exit_group[\s\S]*/, '')],
      ['trace-unparsed', `${trace}unparsed record\n`],
      ['calibration-missing', trace.replaceAll(`htons(5432)`, `htons(5433)`)],
    ])
      await red(
        fault as string,
        async () => observe(broken as string, f.env.PG_IP as string),
        /missing|unparsed|forbidden|truncated/,
      );
    await tracer.reset();
    await tracer.start();
    await f.ready(url);
    await docker('kill', tracer.observer);
    await workload(f, url, 'detached');
    await red('observer-detached', () => tracer.finish(), /toBe/);
    for (const fault of liveFaults) {
      await tracer.reset();
      await traceFault(f, tracer, url, fault);
    }
    await tracer.reset();
    for (const [fault, options, argv] of [
      ['trace-env-mismatch', ['-e', 'BEACON_TRACE_FAULT=1'], undefined],
      ['trace-command-mismatch', [], ['bun', 'apps/server/src/server.ts']],
      [
        'trace-source-mismatch',
        serverMutation(
          f,
          'console.log(`[server] listening on :' + '$' + '{port}`);',
          'console.log(`[server] ready on :' + '$' + '{port}`);',
        ),
        undefined,
      ],
    ] as const) {
      await tracer.start([...options], argv ? [...argv] : undefined);
      await f.ready(url);
      await red(fault, () => parity(f, evidence), /toEqual|toBe/);
      await tracer.finish();
      await tracer.reset();
    }
    f.envFile({ DATABASE_URL: `postgres://beacon:fixture-secret@${f.env.PG}:5432/${f.database}` });
    await tracer.start();
    await workload(f, url, 'hostname');
    const dnsTrace = await tracer.finish();
    await red(
      'hostname-url',
      async () => observe(dnsTrace, f.env.PG_IP as string),
      /UDP|datagram|TCP/,
    );
  } finally {
    await tracer.cleanup();
  }
}
