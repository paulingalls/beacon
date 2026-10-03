type Socket = { type: 'tcp' | 'udp'; peer?: string; inbound?: boolean };
type Call = { pid: number; name: string; args: string; result: string };
const harmless = new Set(
  'faccessat faccessat2 statx timerfd_create timerfd_settime timerfd_gettime tkill tgkill readlinkat readlink read readv pread64 preadv preadv2 open openat openat2 creat newfstatat fstat fstatfs lseek mmap mprotect munmap madvise fadvise64 ftruncate fchmod fchown fsync fdatasync getdents64 getdents poll ppoll select pselect6 epoll_create epoll_create1 epoll_ctl epoll_wait epoll_pwait epoll_pwait2 eventfd eventfd2 pipe pipe2 dup dup2 dup3 fcntl ioctl flock socket connect accept accept4 bind listen shutdown getsockname getpeername getsockopt setsockopt recvfrom recvmsg recvmmsg close clone clone3 fork vfork execve execveat exit exit_group wait4 waitid restart_syscall rt_sigreturn write writev pwrite64 pwritev pwritev2 sendto sendmsg sendmmsg sendfile splice vmsplice tee close_range socketpair io_uring_setup io_uring_register io_uring_enter'.split(
    ' ',
  ),
);
function childPid(c: Call) {
  return Number(
    c.result.match(/\/\* (\d+) in strace's PID NS \*\//)?.[1] ?? c.result.match(/^-?\d+/)?.[0],
  );
}

function calls(trace: string): Call[] {
  const pending = new Map<number, string>();
  const result: Call[] = [];
  for (const raw of trace.trim().split('\n')) {
    const line = raw.match(/^(\d+)\s+(.*)$/);
    if (!line) throw new Error(`unparsed trace: ${raw.slice(0, 100)}`);
    const pid = Number(line[1]);
    let body = line[2] as string;
    if (/^(--- |\+\+\+ )/.test(body)) continue;
    if (body.endsWith('<unfinished ...>')) {
      if (pending.has(pid)) throw new Error('overlapping unfinished calls');
      pending.set(pid, body.replace(/\s*<unfinished \.\.\.>$/, ''));
      continue;
    }
    if (body.startsWith('<... ')) {
      const resume = body.match(/^<\.\.\. (\w+) resumed>(.*)$/);
      const start = pending.get(pid);
      if (!resume || !start?.startsWith(`${resume[1]}(`)) throw new Error('unmatched resumed call');
      body = start + resume[2];
      pending.delete(pid);
    }
    const call = body.match(/^(\w+)\((.*)\)\s+=\s+(.*)$/);
    if (!call) throw new Error(`unparsed trace: ${body.slice(0, 100)}`);
    result.push({
      pid,
      name: call[1] as string,
      args: call[2] as string,
      result: call[3] as string,
    });
  }
  if (pending.size) throw new Error('truncated observation');
  return result;
}
function destination(args: string): string {
  const v4 = args.match(/sin_port=htons\((\d+)\).*sin_addr=inet_addr\("([\d.]+)"\)/);
  const v6 = args.match(/sin6_port=htons\((\d+)\).*inet_pton\(AF_INET6, "([\da-f:]+)"/);
  const match = v4 ?? v6;
  if (!match) throw new Error(`undecoded destination: ${args}`);
  return `${match[2]}:${match[1]}`;
}

export function observe(trace: string, pg: string) {
  const tables = new Map<number, Map<number, Socket>>();
  let started = false;
  let terminal = false;
  let pgAttempts = 0;
  let tcpAttempts = 0;
  let udpAssociations = 0;
  const records = calls(trace);
  const parents = new Map<number, Call>();
  const excluded = new Set<number>();
  for (const c of records)
    if (['clone', 'clone3', 'fork', 'vfork'].includes(c.name) && childPid(c) > 0)
      parents.set(childPid(c), c);
  const tableFor = (pid: number): Map<number, Socket> => {
    const table = tables.get(pid);
    if (table) return table;
    const parent = parents.get(pid);
    if (!parent) throw new Error(`unknown server descendant ${pid}`);
    const inherited = tableFor(parent.pid);
    const child = parent.args.includes('CLONE_FILES') ? inherited : new Map(inherited);
    tables.set(pid, child);
    return child;
  };
  for (const c of records) {
    if (!started) {
      if (c.pid === 1 && c.name === 'execve' && /\/bun"/.test(c.args) && c.result === '0') {
        started = true;
        tables.set(1, new Map());
      } else if (c.pid !== 1) excluded.add(c.pid);
      continue;
    }
    if (excluded.has(c.pid)) continue;
    if (!harmless.has(c.name)) throw new Error(`unknown observed syscall ${c.name}`);
    const table = tableFor(c.pid);
    const fd = Number(c.args.match(/^\d+/)?.[0]);
    const returned = Number(c.result.match(/^-?\d+/)?.[0]);
    const socket = table.get(fd);
    if (c.name.startsWith('io_uring_')) throw new Error(`unsupported ${c.name}`);
    if (['clone', 'clone3', 'fork', 'vfork'].includes(c.name) && returned > 0) {
      if (!tables.has(childPid(c)))
        tables.set(childPid(c), c.args.includes('CLONE_FILES') ? table : new Map(table));
    } else if (c.name === 'socket') {
      if (returned < 0) continue;
      if (!/^AF_INET6?, SOCK_(STREAM|DGRAM)/.test(c.args))
        throw new Error(`unknown socket: ${c.args}`);
      const type = c.args.includes('SOCK_STREAM') ? 'tcp' : 'udp';
      const protocol =
        type === 'tcp' ? /, (?:IPPROTO_IP|IPPROTO_TCP|0)$/ : /, (?:IPPROTO_IP|IPPROTO_UDP|0)$/;
      if (!protocol.test(c.args)) throw new Error(`unknown socket protocol: ${c.args}`);
      table.set(returned, { type });
    } else if (c.name === 'connect') {
      if (!socket) throw new Error('connect on unknown socket');
      const peer = destination(c.args);
      socket.peer = peer;
      if (socket.type === 'tcp') {
        tcpAttempts++;
        if (peer !== `${pg}:5432`) throw new Error(`forbidden TCP attempt: ${peer}`);
        pgAttempts++;
      } else {
        udpAssociations++;
        if (!['0.0.0.0:65535', ':::65535', `${pg}:0`].includes(peer)) {
          throw new Error(`forbidden UDP association: ${peer}`);
        }
      }
    } else if (['accept', 'accept4'].includes(c.name) && returned >= 0) {
      if (socket?.type !== 'tcp') throw new Error('accept on unknown socket');
      table.set(returned, { type: 'tcp', inbound: true });
    } else if (
      [
        'sendto',
        'sendmsg',
        'sendmmsg',
        'write',
        'writev',
        'pwrite64',
        'pwritev',
        'pwritev2',
      ].includes(c.name)
    ) {
      if (!socket) {
        if (/^\d+<.*(?:TCP|UDP|socket:)/.test(c.args) || c.name.startsWith('send')) {
          throw new Error('send on unknown socket');
        }
      } else if (socket.type === 'udp') {
        throw new Error('forbidden datagram send attempt');
      } else if (!socket.inbound && socket.peer !== `${pg}:5432`) {
        throw new Error('write on unclassified outbound socket');
      }
    } else if (['sendfile', 'splice', 'vmsplice', 'tee'].includes(c.name)) {
      // These transfer across multiple fds; reject rather than certify unsupported socket writes.
      throw new Error(`unsupported transfer: ${c.name}`);
    } else if (
      ['dup', 'dup2', 'dup3'].includes(c.name) ||
      (c.name === 'fcntl' && c.args.includes('F_DUPFD'))
    ) {
      if (returned >= 0) {
        table.delete(returned);
        if (socket) table.set(returned, socket);
      }
    } else if (c.name === 'close' && returned === 0) table.delete(fd);
    else if (c.name === 'close_range' || c.name === 'socketpair')
      throw new Error(`unsupported ${c.name}`);
    if (c.pid === 1 && c.name === 'exit_group' && c.args === '0') terminal = true;
  }
  if (!started || !terminal || !trace.match(/^1\s+\+\+\+ exited with 0 \+\+\+$/m))
    throw new Error('missing complete server lifetime');
  if (!pgAttempts) throw new Error('missing Postgres calibration');
  return { tcpAttempts, pgAttempts, udpAssociations };
}
