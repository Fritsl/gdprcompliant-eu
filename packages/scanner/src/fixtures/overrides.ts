import { readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { FixtureRoute } from '@gc/contracts';
import type { FixtureHost } from './server.js';

// A fixture, fixed (R-03): the same host with the change a snippet describes applied on
// top, without touching the files. Headers added, routes put in front, and a page's
// text replaced where the guide says to change it. The replaced page is served as a
// route, so the broken original stays what it is on disk.

export interface HostOverride {
  readonly headers?: Readonly<Record<string, string>>;
  // Put in front of the host's own routes; with replaceRoutes, instead of them.
  readonly routes?: readonly FixtureRoute[];
  readonly replaceRoutes?: boolean;
  // Path → [from, to] pairs applied to the file at that path. Each `from` must occur
  // exactly once, so a proof cannot silently miss.
  readonly replace?: Readonly<Record<string, readonly (readonly [string, string])[]>>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

export class OverrideError extends Error {
  constructor(
    public readonly host: string,
    message: string,
  ) {
    super(`${host}: ${message}`);
    this.name = 'OverrideError';
  }
}

export function applyOverrides(host: FixtureHost, override: HostOverride): FixtureHost {
  const routes: FixtureRoute[] = [];
  for (const [path, pairs] of Object.entries(override.replace ?? {})) {
    const file = join(host.dir, `.${path}`);
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      throw new OverrideError(host.host, `${path} is not a file of this host`);
    }
    for (const [from, to] of pairs) {
      const count = text.split(from).length - 1;
      if (count !== 1)
        throw new OverrideError(host.host, `${path}: "${from.slice(0, 60)}" occurs ${count} times, not once`);
      text = text.replace(from, () => to);
    }
    const route = {
      status: 200,
      headers: { 'content-type': MIME[extname(path).toLowerCase()] ?? 'text/plain; charset=utf-8' },
      body: text,
    };
    routes.push({ path, ...route });
    // A directory's index answers for the directory too, as it does on disk.
    if (path.endsWith('/index.html')) routes.push({ path: path.slice(0, -'index.html'.length), ...route });
  }
  routes.push(...(override.routes ?? []));
  return {
    ...host,
    routes: override.replaceRoutes ? routes : [...routes, ...host.routes],
    ...(override.headers || host.headers
      ? { headers: { ...(host.headers ?? {}), ...(override.headers ?? {}) } }
      : {}),
  };
}
