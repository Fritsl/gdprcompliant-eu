// The documented, conservative list of paths that should never be public, with the
// shape a real exposure has. Rules: docs/decisions/exposed-paths.md.

export interface ExposedPath {
  readonly path: string;
  readonly looksLike: string;
  // The response body must satisfy this to count; a soft 404 or a home page does not.
  readonly matches: (body: string, contentType: string) => boolean;
}

const startsWith = (prefix: string) => (body: string) => body.trimStart().startsWith(prefix);
const includes = (needle: string) => (body: string) => body.includes(needle);
const envLine = (body: string) => /^[A-Z_][A-Z0-9_]*=.+$/m.test(body);
const sqlDump = (body: string) => /\b(CREATE TABLE|INSERT INTO|DROP TABLE)\b/i.test(body);
const binary = (_body: string, contentType: string) => !/^text\/|json|xml|html/i.test(contentType);

export const EXPOSED_PATHS: readonly ExposedPath[] = [
  { path: '/.git/HEAD', looksLike: 'a git checkout', matches: startsWith('ref:') },
  { path: '/.git/config', looksLike: 'a git checkout', matches: includes('[core]') },
  { path: '/.env', looksLike: 'environment variables', matches: envLine },
  { path: '/.env.local', looksLike: 'environment variables', matches: envLine },
  { path: '/.env.production', looksLike: 'environment variables', matches: envLine },
  {
    path: '/wp-config.php.bak',
    looksLike: 'a saved database password',
    matches: includes('DB_PASSWORD'),
  },
  { path: '/phpinfo.php', looksLike: 'server internals', matches: includes('phpinfo') },
  {
    path: '/server-status',
    looksLike: 'Apache internals',
    matches: includes('Apache Server Status'),
  },
  { path: '/.DS_Store', looksLike: 'a directory listing', matches: binary },
  { path: '/backup.zip', looksLike: 'a database dump', matches: binary },
  { path: '/backup.sql', looksLike: 'a database dump', matches: sqlDump },
  { path: '/db.sql', looksLike: 'a database dump', matches: sqlDump },
];

// The name the probes announce, from the published behaviour (D-11).
export const SCANNER_USER_AGENT = scannerUserAgent();

// Whether robots.txt keeps the probe off a path, read the one way the scanner reads it.
export function robotsDisallows(robots: string, path: string, agent?: string): boolean {
  return !robotsAllows(robots, path, agent ?? scannerUserAgent());
}
import { robotsAllows, scannerUserAgent } from '../etiquette.js';
