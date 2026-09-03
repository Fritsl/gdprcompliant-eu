import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FixtureExpectationSchema, FixtureRoutesFileSchema, type FixtureExpectation } from '@gc/contracts';
import type { FixtureHost } from './server.js';

// fixtures/sites/<name>/
//   expected.json                what must and must not come out (FixtureExpectationSchema)
//   hosts/<host>/index.html      the site itself, and every third party it loads
//   hosts/<host>/_routes.json    optional per-path overrides: redirects, headers, statuses
//
// Loading validates all of it, and reads every text file for a URL whose host is not part
// of the fixture: a fixture that references the real internet is refused, because the
// whole point is that nothing in the estate ever reaches it.

export const FIXTURE_SITES_DIR = fileURLToPath(new URL('../../../../fixtures/sites/', import.meta.url));

export interface FixtureSite {
  readonly name: string;
  readonly dir: string;
  readonly expected: FixtureExpectation;
  readonly hosts: readonly FixtureHost[];
}

export class FixtureError extends Error {
  constructor(
    public readonly fixture: string,
    message: string,
  ) {
    super(`fixture ${fixture}: ${message}`);
    this.name = 'FixtureError';
  }
}

const TEXT = new Set(['.html', '.htm', '.js', '.mjs', '.css', '.json', '.svg', '.txt', '.xml']);
const URL_PATTERN = /(?:https?:)?\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?=[/:"'\s)]|$)/gi;
const LOCAL = new Set(['localhost', '127.0.0.1', 'www.w3.org']);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

// Every host a fixture's files refer to that is not one of its own hosts.
export function externalReferences(site: Pick<FixtureSite, 'dir' | 'hosts'>): { file: string; host: string }[] {
  const own = new Set(site.hosts.map((h) => h.host.toLowerCase()));
  const out: { file: string; host: string }[] = [];
  for (const h of site.hosts) {
    for (const file of walk(h.dir)) {
      const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
      if (!TEXT.has(ext)) continue;
      for (const m of readFileSync(file, 'utf8').matchAll(URL_PATTERN)) {
        const host = m[1]!.toLowerCase();
        if (!own.has(host) && !LOCAL.has(host)) {
          out.push({ file: relative(site.dir, file).split(sep).join('/'), host });
        }
      }
    }
  }
  return out;
}

export function loadFixtureSite(dir: string, name = dir.split(/[\\/]/).filter(Boolean).pop() ?? dir): FixtureSite {
  const expectedFile = join(dir, 'expected.json');
  if (!existsSync(expectedFile)) throw new FixtureError(name, 'has no expected.json');
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(expectedFile, 'utf8'));
  } catch (e) {
    throw new FixtureError(name, `expected.json is not valid JSON (${(e as Error).message})`);
  }
  const parsed = FixtureExpectationSchema.safeParse(raw);
  if (!parsed.success) {
    throw new FixtureError(
      name,
      `expected.json: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
    );
  }
  const expected = parsed.data;

  const hostsDir = join(dir, 'hosts');
  if (!existsSync(hostsDir)) throw new FixtureError(name, 'has no hosts/ directory');
  const hosts: FixtureHost[] = readdirSync(hostsDir)
    .filter((h) => statSync(join(hostsDir, h)).isDirectory())
    .sort()
    .map((host) => {
      const hostDir = join(hostsDir, host);
      if (!existsSync(join(hostDir, 'index.html'))) throw new FixtureError(name, `host ${host} has no index.html`);
      let routes: FixtureHost['routes'] = [];
      const routesFile = join(hostDir, '_routes.json');
      if (existsSync(routesFile)) {
        const r = FixtureRoutesFileSchema.safeParse(JSON.parse(readFileSync(routesFile, 'utf8')));
        if (!r.success) throw new FixtureError(name, `${host}/_routes.json: ${r.error.issues[0]?.message}`);
        routes = r.data;
      }
      return { host, dir: hostDir, routes };
    });
  if (hosts.length === 0) throw new FixtureError(name, 'has no hosts');

  const own = new Set(hosts.map((h) => h.host));
  if (!own.has(expected.site)) throw new FixtureError(name, `site ${expected.site} is not one of its hosts`);
  for (const pass of ['firstLoad', 'afterReject', 'afterAccept'] as const) {
    const n = expected.network[pass];
    if (!n) continue;
    for (const h of [...n.mustContact, ...n.mustNotContact]) {
      if (!own.has(h)) throw new FixtureError(name, `network.${pass} names ${h}, which is not a fixture host`);
    }
  }

  const external = externalReferences({ dir, hosts });
  if (external.length > 0) {
    const list = external.map((e) => `${e.file} → ${e.host}`).join(', ');
    throw new FixtureError(name, `references the real internet: ${list}. Simulate it as a host under hosts/.`);
  }

  return { name, dir, expected, hosts };
}

export function loadFixtureSites(dir: string = FIXTURE_SITES_DIR): FixtureSite[] {
  return readdirSync(dir)
    .filter((entry) => statSync(join(dir, entry)).isDirectory())
    .sort()
    .map((name) => loadFixtureSite(join(dir, name), name));
}
