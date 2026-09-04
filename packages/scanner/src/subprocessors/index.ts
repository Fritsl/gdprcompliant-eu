import {
  EvidenceSchema,
  SubProcessorListSchema,
  SupplyChainSchema,
  sha256,
  type CountryCode,
  type Evidence,
  type SubProcessorEntry,
  type SubProcessorList,
  type SupplyChain,
  type SupplyChainEdge,
  type SupplyChainLimits,
  type SupplyChainNode,
  type SupplyChainSkip,
} from '@gc/contracts';
import type { Page } from 'playwright';
import { readPage, type PageRead } from '../discovery/policies.js';
import type { LinkCandidate } from '../discovery/patterns.js';
import { refTo, type EvidenceIdentity } from '../evidence.js';
import type { BrowserPool } from '../pool.js';
import { consentGate, loadBehaviour, robotsAllows, scannerUserAgent } from '../etiquette.js';

export { robotsAllows };

// Sub-processor lists and the walk along them (D-07). A supplier's list is found the way
// a policy is (a link that looks like one, then the paths such a page lives at), read
// line by line for the companies it names, and each company with a site of its own is
// visited in turn, breadth first, to a depth and a size that are enforced, not hoped
// for. A company already on the chain is a cycle: the edge is kept and the walk does not
// follow it. Every request waits its turn per host and asks robots.txt first. Every
// edge carries the page it was read from and the moment it was read.

export const LIST_TEXT =
  /\b(sub-?processors?|subprocessors?|underdatabehandler\w*|underleverand\w*|unterauftragsverarbeiter\w*|subunternehmer|third[- ]party (service )?providers|service providers)\b/i;
export const LIST_PATH =
  /sub-?processor|subprocessor|underdatabehandler|underleverandoer|unterauftragsverarbeit|third-part|service-providers|vendors/i;

export const WELL_KNOWN_LIST_PATHS: readonly string[] = [
  '/sub-processors',
  '/subprocessors',
  '/legal/sub-processors',
  '/legal/subprocessors',
  '/underdatabehandlere',
  '/unterauftragsverarbeiter',
  '/legal/vendors',
];

export const DEFAULT_LIMITS: SupplyChainLimits = {
  maxDepth: 3,
  maxNodes: 25,
  minIntervalMs: 2_000,
  respectRobots: true,
};

// The group a robots.txt may address us by, from the published behaviour (D-11).
export const CRAWLER_AGENT = loadBehaviour().identity.robotsGroup;

// ---- reading one list ------------------------------------------------------------------

const COMPANY =
  /\b(Inc\.?|LLC|L\.L\.C\.|Ltd\.?|Limited|GmbH|ApS|A\/S|AB|Oy|Oyj|B\.?V\.?|N\.?V\.?|S\.A\.?|S\.A\.S\.?|SAS|SARL|S\.r\.l\.?|Corp\.?|Corporation|AG|SE|plc|PLC|Co\.|Company|Technologies|Software|Cloud|Hosting|Services)\b/;
const DOMAIN = /\b((?:[a-z0-9-]+\.)+(?:[a-z]{2,}))\b/gi;
const SEPARATOR = /\s*(?:\t|\||;|\s[–—-]\s|,\s|\s\()\s*/;

const COUNTRIES: readonly [RegExp, CountryCode][] = [
  [/\b(United States|USA|U\.S\.A?\.?|US|Vereinigte Staaten|Amerika)\b/i, 'US'],
  [/\b(Ireland|Irland)\b/i, 'IE'],
  [/\b(Germany|Tyskland|Deutschland)\b/i, 'DE'],
  [/\b(Denmark|Danmark|Dänemark)\b/i, 'DK'],
  [/\b(Netherlands|Holland|Nederlandene|Niederlande)\b/i, 'NL'],
  [/\b(Sweden|Sverige|Schweden)\b/i, 'SE'],
  [/\b(Finland|Finnland)\b/i, 'FI'],
  [/\b(Norway|Norge|Norwegen)\b/i, 'NO'],
  [/\b(United Kingdom|UK|Storbritannien|Großbritannien|Vereinigtes Königreich|England)\b/i, 'GB'],
  [/\b(France|Frankrig|Frankreich)\b/i, 'FR'],
  [/\b(Belgium|Belgien)\b/i, 'BE'],
  [/\b(Switzerland|Schweiz)\b/i, 'CH'],
  [/\b(Canada|Kanada)\b/i, 'CA'],
  [/\b(India|Indien)\b/i, 'IN'],
  [/\b(Australia|Australien)\b/i, 'AU'],
  [/\b(Japan)\b/i, 'JP'],
  [/\b(Israel)\b/i, 'IL'],
  [/\b(Spain|Spanien)\b/i, 'ES'],
  [/\b(Italy|Italien)\b/i, 'IT'],
  [/\b(Poland|Polen)\b/i, 'PL'],
  [/\b(Austria|Østrig|Österreich)\b/i, 'AT'],
  [/\b(Luxembourg|Luxemburg)\b/i, 'LU'],
  [/\b(Estonia|Estland)\b/i, 'EE'],
];

export function countryIn(text: string): CountryCode | undefined {
  for (const [pattern, code] of COUNTRIES) if (pattern.test(text)) return code;
  return undefined;
}

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();
const within = (host: string, site: string) => host === site || host.endsWith(`.${site}`);
export const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

// The companies a page names, one per line that reads as a company: a corporate suffix,
// a domain that is not the page's own, or a country. The name is the line up to its
// first separator; the site is a domain on the line or an off-site link with the name.
export function parseSubProcessorEntries(
  read: Pick<PageRead, 'text' | 'links'>,
  site: string,
): SubProcessorEntry[] {
  const own = site.replace(/^www\./, '');
  const out = new Map<string, SubProcessorEntry>();
  for (const raw of read.text.split(/\r?\n/)) {
    // Tabs are cell boundaries in a table read as text; they split, then they collapse.
    const cells = raw.replace(/[ \u00a0]+/g, ' ').trim();
    const line = collapse(raw);
    if (line.length < 3 || line.length > 300) continue;
    const domains = [...line.matchAll(DOMAIN)]
      .map((m) => m[1]!.toLowerCase())
      .filter((d) => !within(d, own) && !/\.(png|jpg|svg|pdf|html?)$/.test(d));
    const country = countryIn(line);
    if (!COMPANY.test(line) && domains.length === 0 && country === undefined) continue;
    const segments = cells
      .split(SEPARATOR)
      .map((s) => collapse(s))
      .filter(Boolean);
    const name = (segments[0] ?? line).replace(/[.:]$/, '').slice(0, 80);
    if (!/[A-Za-zÀ-ž]/.test(name) || LIST_TEXT.test(name)) continue;
    const key = name.toLowerCase();
    if (out.has(key)) continue;
    let host = domains[0];
    if (!host) {
      const link = read.links.find((l) => {
        const text = collapse(l.text).toLowerCase();
        if (!text || !(text.includes(key) || key.includes(text))) return false;
        try {
          return !within(new URL(l.href).hostname.toLowerCase(), own);
        } catch {
          return false;
        }
      });
      if (link) host = new URL(link.href).hostname.toLowerCase();
    }
    const purpose = segments
      .slice(1)
      .find((s) => !DOMAIN.test(s) && countryIn(s) === undefined && !/^\d/.test(s));
    out.set(key, {
      name,
      ...(host ? { host } : {}),
      ...(country ? { country } : {}),
      ...(purpose ? { purpose: purpose.slice(0, 120) } : {}),
      // Verbatim from the page, tabs included: a substring of the stored body.
      quote: raw.trim(),
    });
  }
  return [...out.values()];
}

export function scoreListLink(link: LinkCandidate): number {
  let path = '';
  try {
    path = decodeURIComponent(new URL(link.href, 'http://x.invalid').pathname);
  } catch {
    path = link.href;
  }
  const text = collapse(link.text);
  if (consentGate(text)) return 0;
  let score = 0;
  if (LIST_TEXT.test(text)) score += 10;
  if (LIST_PATH.test(path)) score += 5;
  if (score === 0) return 0;
  if (link.inFooter) score += 2;
  if (text.length > 60) score -= 3;
  return score;
}

// ---- politeness ---------------------------------------------------------------------------

export interface PolitenessOptions {
  readonly minIntervalMs: number;
  readonly respectRobots: boolean;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
}

// One request per host per interval, and robots.txt asked once per host before the
// first. Every request is logged, so the record can be checked.
export class Politeness {
  readonly requests: { host: string; url: string; at: string }[] = [];
  private readonly lastAt = new Map<string, number>();
  private readonly robots = new Map<string, string | undefined>();
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: PolitenessOptions) {
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  // Wait until this host may be asked again, then record the request.
  async before(host: string, url: string): Promise<void> {
    const last = this.lastAt.get(host);
    if (last !== undefined) {
      const wait = last + this.options.minIntervalMs - this.now().getTime();
      if (wait > 0) await this.sleep(wait);
    }
    const at = this.now();
    this.lastAt.set(host, at.getTime());
    this.requests.push({ host, url, at: at.toISOString() });
  }

  // Whether robots.txt lets us read a path on this host; the file is fetched once.
  async allows(
    host: string,
    origin: string,
    path: string,
    readRobots: (url: string) => Promise<string | undefined>,
  ): Promise<boolean> {
    if (!this.options.respectRobots) return true;
    if (!this.robots.has(host)) {
      const url = `${origin}/robots.txt`;
      await this.before(host, url);
      this.robots.set(host, await readRobots(url));
    }
    const robots = this.robots.get(host);
    return robots === undefined ? true : robotsAllows(robots, path);
  }
}

// ---- reading one supplier -------------------------------------------------------------------

async function fetchText(page: Page, url: string): Promise<string | undefined> {
  try {
    const response = await page.goto(url, { waitUntil: 'load' });
    if (!response || response.status() >= 400) return undefined;
    return (await page.evaluate("(document.body && document.body.innerText) || ''")) as string;
  } catch {
    return undefined;
  }
}

function evidenceRow(
  identity: EvidenceIdentity,
  body: string,
  source: Evidence['source'],
  caption: string,
): Evidence {
  const hash = sha256(body);
  return EvidenceSchema.parse({
    id: `document:${hash.slice(0, 16)}`,
    tenantId: identity.tenantId,
    caseId: identity.caseId,
    ...(identity.scanId !== undefined ? { scanId: identity.scanId } : {}),
    kind: 'document',
    capturedAt: identity.capturedAt,
    source,
    body,
    hash,
    caption,
  });
}

export interface ListReadOptions {
  readonly identity: EvidenceIdentity;
  readonly polite: Politeness;
  readonly vendorName?: string;
  readonly maxPages?: number;
  readonly now?: () => Date;
}

export type ListRead =
  | { readonly outcome: 'read'; readonly list: SubProcessorList; readonly evidence: Evidence }
  | {
      readonly outcome: 'skipped';
      readonly reason: Extract<SupplyChainSkip, 'robots' | 'unreachable' | 'no_list'>;
    };

// One supplier's list: robots first, then the home page for a link, then the paths
// such a page lives at, each request in its turn.
export async function readSubProcessorList(
  page: Page,
  origin: string,
  options: ListReadOptions,
): Promise<ListRead> {
  const host = new URL(origin).hostname.toLowerCase();
  const now = options.now ?? (() => new Date());
  const maxPages = options.maxPages ?? 5;
  const robotsFetch = (url: string) => fetchText(page, url);
  let fetched = 0;
  const visited = new Set<string>();

  const get = async (url: string): Promise<PageRead | undefined | 'robots'> => {
    const path = new URL(url).pathname;
    if (visited.has(path) || fetched >= maxPages) return undefined;
    visited.add(path);
    if (!(await options.polite.allows(host, origin, path, robotsFetch))) return 'robots';
    fetched++;
    await options.polite.before(host, url);
    return readPage(page, url);
  };

  const accept = (
    r: PageRead,
    url: string,
    foundBy: 'link' | 'well-known',
  ): ListRead | undefined => {
    const entries = parseSubProcessorEntries(r, host);
    if (entries.length === 0) return undefined;
    const looksLikeList = LIST_TEXT.test(r.title ?? '') || LIST_TEXT.test(r.text.slice(0, 600));
    if (!looksLikeList) return undefined;
    const evidence = evidenceRow(
      options.identity,
      r.text,
      { url: r.finalUrl, host: new URL(r.finalUrl).hostname },
      `sub-processor list of ${options.vendorName ?? host} at ${r.finalUrl}: ${entries.length} name(s)`,
    );
    const list = SubProcessorListSchema.parse({
      vendor: { host, ...(options.vendorName ? { name: options.vendorName } : {}) },
      url,
      finalUrl: r.finalUrl,
      ...(r.title ? { title: r.title } : {}),
      fetchedAt: now().toISOString(),
      foundBy,
      evidence: refTo(evidence),
      entries,
    });
    return { outcome: 'read', list, evidence };
  };

  const home = await get(`${origin}/`);
  if (home === 'robots') return { outcome: 'skipped', reason: 'robots' };
  if (!home) return { outcome: 'skipped', reason: 'unreachable' };
  // The home page may itself carry the list.
  const onHome = accept(home, `${origin}/`, 'well-known');
  if (onHome) return onHome;

  const candidates = home.links
    .map((l) => ({ link: l, score: scoreListLink(l) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  let robotsHit = false;
  for (const { link } of candidates) {
    let target: URL;
    try {
      target = new URL(link.href);
    } catch {
      continue;
    }
    if (!within(target.hostname.toLowerCase(), host.replace(/^www\./, ''))) continue;
    const r = await get(target.toString());
    if (r === 'robots') {
      robotsHit = true;
      continue;
    }
    if (!r) continue;
    const read = accept(r, target.toString(), 'link');
    if (read) return read;
  }
  for (const path of WELL_KNOWN_LIST_PATHS) {
    const url = `${origin}${path}`;
    const r = await get(url);
    if (r === 'robots') {
      robotsHit = true;
      continue;
    }
    if (!r) continue;
    const read = accept(r, url, 'well-known');
    if (read) return read;
  }
  return { outcome: 'skipped', reason: robotsHit && candidates.length > 0 ? 'robots' : 'no_list' };
}

// ---- the walk --------------------------------------------------------------------------------

export interface SupplyChainOptions {
  readonly identity: EvidenceIdentity;
  readonly vendorName?: string;
  readonly limits?: Partial<SupplyChainLimits>;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface SupplyChainResult {
  readonly chain: SupplyChain;
  readonly lists: SubProcessorList[];
  readonly evidence: Evidence[];
}

export async function traverseSupplyChain(
  pool: BrowserPool,
  target: { readonly url: string },
  options: SupplyChainOptions,
): Promise<SupplyChainResult> {
  const limits: SupplyChainLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const now = options.now ?? (() => new Date());
  const rootUrl = new URL(target.url);
  const scheme = rootUrl.protocol;
  const root = rootUrl.hostname.toLowerCase();
  const startedAt = now().toISOString();
  const polite = new Politeness({
    minIntervalMs: limits.minIntervalMs,
    respectRobots: limits.respectRobots,
    now,
    ...(options.sleep ? { sleep: options.sleep } : {}),
  });

  const nodes: SupplyChainNode[] = [
    { id: root, name: options.vendorName ?? root, host: root, depth: 0, list: 'read' },
  ];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges: SupplyChainEdge[] = [];
  const lists: SubProcessorList[] = [];
  const evidence: Evidence[] = [];
  const queue: SupplyChainNode[] = [nodes[0]!];
  let stoppedBy: SupplyChain['stoppedBy'];
  let dropped = 0;

  const settle = (node: SupplyChainNode, patch: Partial<SupplyChainNode>) => {
    const i = nodes.findIndex((n) => n.id === node.id);
    const next: SupplyChainNode = { ...nodes[i]!, ...patch };
    // A list that was read has nothing to explain.
    if (next.list === 'read') delete (next as { skipped?: unknown }).skipped;
    nodes[i] = next;
    byId.set(next.id, next);
    return next;
  };

  while (queue.length > 0) {
    const node = queue.shift()!;
    if (!node.host) {
      settle(node, { list: 'skipped', skipped: 'no_site' });
      continue;
    }
    if (node.depth >= limits.maxDepth) {
      settle(node, { list: 'skipped', skipped: 'depth' });
      stoppedBy = stoppedBy ?? 'depth';
      continue;
    }
    const origin = `${scheme}//${node.host}`;
    const read = await pool.run({ url: `${origin}/`, userAgent: scannerUserAgent() }, (page) =>
      readSubProcessorList(page, origin, {
        identity: options.identity,
        polite,
        ...(node.depth === 0 && options.vendorName ? { vendorName: options.vendorName } : {}),
        now,
      }),
    );
    if (read.outcome === 'skipped') {
      settle(node, { list: 'skipped', skipped: read.reason });
      continue;
    }
    settle(node, { list: 'read' });
    lists.push(read.list);
    evidence.push(read.evidence);
    const document = {
      url: read.list.finalUrl,
      fetchedAt: read.list.fetchedAt,
      evidence: read.list.evidence,
    };
    for (const entry of read.list.entries) {
      const id = entry.host ?? `name:${slug(entry.name)}`;
      const known = byId.get(id);
      if (known) {
        edges.push({ from: node.id, to: id, document, entry, cycle: true });
        continue;
      }
      if (nodes.length >= limits.maxNodes) {
        stoppedBy = stoppedBy ?? 'nodes';
        dropped += 1;
        continue;
      }
      const next: SupplyChainNode = {
        id,
        name: entry.name,
        ...(entry.host ? { host: entry.host } : {}),
        ...(entry.country ? { country: entry.country } : {}),
        depth: node.depth + 1,
        list: 'skipped',
        skipped: entry.host ? 'depth' : 'no_site',
      };
      nodes.push(next);
      byId.set(id, next);
      edges.push({ from: node.id, to: id, document, entry, cycle: false });
      queue.push(next);
    }
  }

  const chain = SupplyChainSchema.parse({
    root,
    startedAt,
    finishedAt: now().toISOString(),
    limits,
    nodes,
    edges,
    ...(stoppedBy ? { stoppedBy } : {}),
    dropped,
    requests: polite.requests,
  });
  return { chain, lists, evidence };
}
