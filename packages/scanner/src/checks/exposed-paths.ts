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

export const SCANNER_USER_AGENT = 'GDPRcompliant-scanner';

// The subset of robots.txt that matters here: which paths are disallowed for everyone,
// or for us by name. Allow rules are honoured when more specific than the disallow.
export function robotsDisallows(robots: string, path: string, agent = SCANNER_USER_AGENT): boolean {
  const groups: { agents: string[]; allow: string[]; disallow: string[] }[] = [];
  let current: (typeof groups)[number] | undefined;
  let lastWasAgent = false;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const [key, ...rest] = line.split(':');
    const value = rest.join(':').trim();
    const k = (key ?? '').trim().toLowerCase();
    if (k === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], allow: [], disallow: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (k === 'disallow' && value) current.disallow.push(value);
    if (k === 'allow' && value) current.allow.push(value);
  }
  const mine = groups.filter((g) => g.agents.some((a) => a === agent.toLowerCase()));
  const applicable = mine.length > 0 ? mine : groups.filter((g) => g.agents.includes('*'));
  const longest = (rules: string[]) =>
    rules
      .filter((r) => path.startsWith(r.replace(/\$$/, '')))
      .sort((a, b) => b.length - a.length)[0];
  for (const g of applicable) {
    const dis = longest(g.disallow);
    const allow = longest(g.allow);
    if (dis && (!allow || allow.length < dis.length)) return true;
  }
  return false;
}
