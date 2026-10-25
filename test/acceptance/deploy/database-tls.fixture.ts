import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createConnection, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TLSSocket } from 'node:tls';

export async function tlsDatabase(database: string) {
  const dir = mkdtempSync(join(tmpdir(), 'beacon-tls-'));
  const openssl = (...args: string[]) => {
    const p = Bun.spawnSync(['openssl', ...args], { cwd: dir });
    if (p.exitCode) throw new Error(p.stderr.toString());
  };
  for (const name of ['ca', 'other']) {
    openssl(
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:P-256',
      '-nodes',
      '-keyout',
      `${name}.key`,
      '-out',
      `${name}.crt`,
      '-days',
      '1',
      '-subj',
      `/CN=${name}`,
    );
  }
  for (const name of ['localhost', 'wrong.example']) {
    openssl(
      'req',
      '-new',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:P-256',
      '-nodes',
      '-keyout',
      `${name}.key`,
      '-out',
      `${name}.csr`,
      '-subj',
      `/CN=${name}`,
    );
    await Bun.write(join(dir, 'extensions'), `subjectAltName=DNS:${name}\n`);
    openssl(
      'x509',
      '-req',
      '-in',
      `${name}.csr`,
      '-CA',
      'ca.crt',
      '-CAkey',
      'ca.key',
      '-CAcreateserial',
      '-out',
      `${name}.crt`,
      '-days',
      '1',
      '-extfile',
      'extensions',
    );
  }
  const sockets = new Set<Socket>();
  const upstream = new URL(database);
  let hostname = 'localhost';
  let accepted = 0;
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.on('close', () => sockets.delete(socket));
    socket.setTimeout(5000, () => socket.destroy());
    return socket;
  };
  const proxy = createServer((socket) => {
    accepted++;
    track(socket);
    socket.once('data', (request) => {
      if (request.length !== 8 || request.readInt32BE(4) !== 80877103) {
        socket.destroy(new Error('Expected PostgreSQL SSLRequest'));
        return;
      }
      socket.write('S');
      const secure = track(
        new TLSSocket(socket, {
          isServer: true,
          key: readFileSync(join(dir, `${hostname}.key`)),
          cert: readFileSync(join(dir, `${hostname}.crt`)),
        }),
      );
      const db = track(
        createConnection({ host: upstream.hostname, port: Number(upstream.port || 5432) }),
      );
      secure.pipe(db).pipe(secure);
      secure.on('close', () => db.destroy());
      db.on('close', () => secure.destroy());
    });
  });
  await new Promise<void>((resolve, reject) => {
    proxy.once('error', reject);
    proxy.listen(0, '127.0.0.1', resolve);
  });
  const address = proxy.address();
  if (!address || typeof address === 'string') throw new Error('No proxy port');
  const url = new URL(database);
  url.hostname = 'localhost';
  url.port = String(address.port);
  return {
    dir,
    ca: join(dir, 'ca.crt'),
    other: join(dir, 'other.crt'),
    accepted: () => accepted,
    hostname: (name: string) => {
      hostname = name;
    },
    url(mode: string) {
      url.searchParams.set('sslmode', mode);
      return String(url);
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
