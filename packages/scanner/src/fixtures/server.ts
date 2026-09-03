import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { extname, join, resolve, sep } from 'node:path';
import type { FixtureRoute } from '@gc/contracts';

// One local server for every host in a fixture estate. The browser is pointed at it as
// its HTTP proxy, so a request for http://analytics.tracker.test/tag.js arrives here
// with the full URL and is answered from hosts/analytics.tracker.test/tag.js. A host
// that is not part of the fixture is refused with a 502 and recorded, and CONNECT (TLS)
// is refused outright: no fixture, and nothing a fixture loads, can reach the internet.
//
// This module listens; it never connects out. It is the one place outside @gc/config
// allowed to import node:http.

export interface FixtureHost {
  readonly host: string;
  readonly dir: string;
  readonly routes: readonly FixtureRoute[];
}

export interface RefusedRequest {
  readonly method: string;
  readonly host: string;
  readonly url: string;
}

export interface ServedRequest {
  readonly host: string;
  readonly path: string;
  readonly status: number;
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
};

export class FixtureServer {
  readonly refused: RefusedRequest[] = [];
  readonly served: ServedRequest[] = [];
  private readonly hosts = new Map<string, FixtureHost>();
  private server: Server | undefined;

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

  async start(port = 0): Promise<this> {
    const server = createServer((req, res) => void this.handle(req, res));
    server.on('connect', (req, socket: Socket) => {
      const host = (req.url ?? '').split(':')[0] ?? '';
      this.refused.push({ method: 'CONNECT', host, url: req.url ?? '' });
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
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
    await new Promise<void>((resolveStop) => server.close(() => resolveStop()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = req.url ?? '/';
    let url: URL;
    try {
      // Proxy-style requests carry the absolute URL; direct ones carry a Host header.
      url = raw.startsWith('http://') || raw.startsWith('https://')
        ? new URL(raw)
        : new URL(raw, `http://${req.headers.host ?? 'unknown.invalid'}`);
    } catch {
      res.writeHead(400).end();
      return;
    }

    const host = url.hostname.toLowerCase();
    const fixture = this.hosts.get(host);
    if (!fixture) {
      this.refused.push({ method: req.method ?? 'GET', host, url: url.toString() });
      res
        .writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
        .end(JSON.stringify({ refused: host, reason: 'not a fixture host — fixtures never reach the internet' }));
      return;
    }

    const route = fixture.routes.find((r) => r.path === url.pathname);
    if (route) {
      this.served.push({ host, path: url.pathname, status: route.status });
      res.writeHead(route.status, { 'content-length': '0', ...route.headers });
      res.end(route.body ?? '');
      return;
    }

    const file = await this.resolveFile(fixture.dir, url.pathname);
    if (!file) {
      this.served.push({ host, path: url.pathname, status: 404 });
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not in fixture');
      return;
    }
    const body = await readFile(file);
    this.served.push({ host, path: url.pathname, status: 200 });
    res
      .writeHead(200, {
        'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'content-length': String(body.length),
        'cache-control': 'no-store',
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
