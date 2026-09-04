import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { extname, join, resolve, sep } from 'node:path';
import { TLSSocket } from 'node:tls';
import type { FixtureRoute } from '@gc/contracts';
import * as selfsigned from 'selfsigned';

// One local server for every host in a fixture estate. The browser is pointed at it as
// its HTTP proxy, so a request for http://analytics.tracker.test/tag.js arrives here
// with the full URL and is answered from hosts/analytics.tracker.test/tag.js. A host
// that is not part of the fixture is refused with a 502 and recorded.
//
// HTTPS works the same way: a CONNECT for a fixture host is answered with a tunnel that
// this server terminates itself, with a certificate it generated at start-up for every
// fixture host. The browser is told to accept it (ignoreHTTPSErrors). A CONNECT for any
// other host, or for a fixture host declared without TLS, is refused: no fixture, and
// nothing a fixture loads, can reach the internet.
//
// This module listens; it never connects out. It is the one place outside @gc/config
// allowed to import node:http.

export interface FixtureHost {
  readonly host: string;
  readonly dir: string;
  readonly routes: readonly FixtureRoute[];
  // Extra response headers on every answer from this host: HSTS, CSP, and so on.
  readonly headers?: Readonly<Record<string, string>>;
  // A host that has no certificate at all. Default: TLS is available.
  readonly tls?: boolean;
}

export interface RefusedRequest {
  readonly method: string;
  readonly host: string;
  readonly url: string;
}

export interface ServedRequest {
  readonly method: string;
  readonly scheme: 'http' | 'https';
  readonly host: string;
  readonly path: string;
  readonly status: number;
  // Who asked, and when: the user agent, the scanner's own header, the moment.
  readonly userAgent: string;
  readonly scanner?: string;
  readonly at: number;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.sql': 'application/sql',
  '.zip': 'application/zip',
};

const asked = (req: IncomingMessage) => {
  const scanner = req.headers['x-gdprcompliant-scanner'];
  return {
    userAgent: String(req.headers['user-agent'] ?? ''),
    ...(typeof scanner === 'string' ? { scanner } : {}),
    at: Date.now(),
  };
};

export class FixtureServer {
  readonly refused: RefusedRequest[] = [];
  readonly served: ServedRequest[] = [];
  private readonly hosts = new Map<string, FixtureHost>();
  private server: Server | undefined;
  private tls: { key: string; cert: string } | undefined;

  constructor(hosts: Iterable<FixtureHost>) {
    for (const h of hosts) this.hosts.set(h.host.toLowerCase(), h);
  }

  hostNames(): string[] {
    return [...this.hosts.keys()].sort();
  }

  get port(): number {
    const address = this.server?.address() as AddressInfo | null | undefined;
    if (!address) throw new Error('fixture server is not listening');
    return address.port;
  }

  // The value for the browser's --proxy-server.
  get proxy(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  // The certificate the tunnel presents, for clients that want to trust it explicitly.
  get certificate(): string {
    if (!this.tls) throw new Error('fixture server is not listening');
    return this.tls.cert;
  }

  async start(port = 0): Promise<this> {
    const pems = await selfsigned.generate([{ name: 'commonName', value: 'fixture estate' }], {
      keySize: 2048,
      notAfterDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      extensions: [
        {
          name: 'subjectAltName',
          altNames: this.hostNames().map((host) => ({ type: 2, value: host })),
        },
      ],
    });
    this.tls = { key: pems.private, cert: pems.cert };

    const server = createServer((req, res) => void this.handle(req, res));
    server.on('connect', (req, socket: Socket, head: Buffer) => {
      const [hostPart, portPart] = (req.url ?? '').split(':');
      const host = hostPart?.toLowerCase() ?? '';
      const port = Number(portPart ?? '443');
      const fixture = this.hosts.get(host);
      // Some clients tunnel plain HTTP too; a CONNECT to port 80 gets a plain tunnel.
      if (fixture && port !== 443) {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) socket.unshift(head);
        server.emit('connection', socket);
        return;
      }
      if (!fixture || fixture.tls === false) {
        this.refused.push({ method: 'CONNECT', host, url: req.url ?? '' });
        socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      const tls = new TLSSocket(socket, {
        isServer: true,
        key: this.tls!.key,
        cert: this.tls!.cert,
      });
      tls.on('error', () => socket.destroy());
      if (head.length > 0) tls.unshift(head);
      // The decrypted stream is ordinary HTTP; hand it to the same server.
      server.emit('connection', tls);
    });
    await new Promise<void>((resolveStart, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolveStart());
    });
    this.server = server;
    return this;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    server.closeAllConnections();
    await new Promise<void>((resolveStop) => server.close(() => resolveStop()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = req.url ?? '/';
    const scheme: 'http' | 'https' = (req.socket as TLSSocket).encrypted ? 'https' : 'http';
    const method = req.method ?? 'GET';
    let url: URL;
    try {
      // Proxy-style requests carry the absolute URL; direct ones carry a Host header.
      url =
        raw.startsWith('http://') || raw.startsWith('https://')
          ? new URL(raw)
          : new URL(
              raw,
              // A client that cannot set Host (fetch forbids it) says so in X-Forwarded-Host.
              `${scheme}://${req.headers['x-forwarded-host'] ?? req.headers.host ?? 'unknown.invalid'}`,
            );
    } catch {
      res.writeHead(400).end();
      return;
    }

    const host = url.hostname.toLowerCase();
    const fixture = this.hosts.get(host);
    if (!fixture) {
      this.refused.push({ method, host, url: url.toString() });
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' }).end(
        JSON.stringify({
          refused: host,
          reason: 'not a fixture host — fixtures never reach the internet',
        }),
      );
      return;
    }

    const extra = fixture.headers ?? {};
    const userAgent = String(req.headers['user-agent'] ?? '');
    const route = fixture.routes.find(
      (r) =>
        r.path === url.pathname &&
        (r.scheme === undefined || r.scheme === scheme) &&
        (r.userAgent === undefined || userAgent.includes(r.userAgent)),
    );
    if (route) {
      this.served.push({ method, scheme, host, path: url.pathname, status: route.status, ...asked(req) });
      if (route.delayMs) await new Promise((r) => setTimeout(r, route.delayMs));
      if (req.destroyed) return;
      if (route.bytes) {
        // A bloated answer: the body repeated to the size asked for, streamed in pieces.
        const unit = Buffer.from(route.body && route.body.length > 0 ? route.body : 'x');
        res.writeHead(route.status, {
          'content-length': String(route.bytes),
          ...extra,
          ...route.headers,
        });
        let left = route.bytes;
        const piece = Buffer.alloc(Math.min(64 * 1024, unit.length * Math.ceil((64 * 1024) / unit.length)));
        for (let i = 0; i < piece.length; i += unit.length) unit.copy(piece, i, 0, Math.min(unit.length, piece.length - i));
        const pump = () => {
          while (left > 0) {
            const n = Math.min(left, piece.length);
            left -= n;
            if (!res.write(n === piece.length ? piece : piece.subarray(0, n))) {
              res.once('drain', pump);
              return;
            }
          }
          res.end();
        };
        pump();
        return;
      }
      const body = route.body ?? '';
      res.writeHead(route.status, {
        'content-length': String(Buffer.byteLength(body)),
        ...extra,
        ...route.headers,
      });
      res.end(body);
      return;
    }

    const file = await this.resolveFile(fixture.dir, url.pathname);
    if (!file) {
      this.served.push({ method, scheme, host, path: url.pathname, status: 404, ...asked(req) });
      res
        .writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...extra })
        .end('not in fixture');
      return;
    }
    const body = await readFile(file);
    this.served.push({ method, scheme, host, path: url.pathname, status: 200, ...asked(req) });
    res
      .writeHead(200, {
        'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'content-length': String(body.length),
        'cache-control': 'no-store',
        ...extra,
      })
      .end(body);
  }

  private async resolveFile(dir: string, pathname: string): Promise<string | undefined> {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return undefined;
    }
    // Fixture configuration files are not part of the site.
    if (/(^|\/)_[^/]*\.json$/.test(decoded)) return undefined;
    const root = resolve(dir);
    const candidate = resolve(root, `.${decoded}`);
    // No path may escape the host directory.
    if (candidate !== root && !candidate.startsWith(root + sep)) return undefined;
    try {
      const s = await stat(candidate);
      if (s.isDirectory()) {
        const index = join(candidate, 'index.html');
        return (await stat(index)).isFile() ? index : undefined;
      }
      return s.isFile() ? candidate : undefined;
    } catch {
      return undefined;
    }
  }
}
