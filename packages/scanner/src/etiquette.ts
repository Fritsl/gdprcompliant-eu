import {
  identityHeaders,
  loadBehaviour,
  scannerUserAgent,
  type Behaviour,
  type BehaviourLimits,
} from '@gc/config';

// Crawl etiquette (D-11): who the scanner says it is, how fast it goes, what it never
// does, and which pages robots.txt keeps it from. All of it is content in
// data/behaviour.json, rendered on the page the user agent points at, so the page and
// the code cannot say different things. The limits are kept here, once, and enforced
// where every request passes (the egress guard on every browser context), never by
// the individual collectors.

// The published behaviour itself lives in @gc/config, where the web app can render it
// without depending on the scanner; here it is read and enforced.
export {
  BEHAVIOUR_FILE,
  BehaviourSchema,
  behaviourValues,
  fillBehaviour,
  identityHeaders,
  loadBehaviour,
  scannerUserAgent,
  type Behaviour,
} from '@gc/config';
export type EtiquetteLimits = BehaviourLimits;

// ---- robots.txt --------------------------------------------------------------------------

// robots.txt, read for the group that addresses us or everyone: the longest matching
// rule wins, Allow over Disallow at equal length, and no rule means allowed.
export function robotsAllows(
  robots: string,
  path: string,
  agent: string = scannerUserAgent(),
): boolean {
  const groups: { agents: string[]; rules: { allow: boolean; prefix: string }[] }[] = [];
  let current: (typeof groups)[number] | undefined;
  let lastWasAgent = false;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const field = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current || (field !== 'allow' && field !== 'disallow')) continue;
    if (value === '' && field === 'disallow') continue; // "Disallow:" allows everything
    current.rules.push({ allow: field === 'allow', prefix: value });
  }
  const me = agent.toLowerCase();
  const mine = groups.filter((g) => g.agents.some((a) => a !== '*' && me.includes(a)));
  const applicable = mine.length > 0 ? mine : groups.filter((g) => g.agents.includes('*'));
  let best: { allow: boolean; length: number } | undefined;
  for (const g of applicable) {
    for (const r of g.rules) {
      const prefix = r.prefix.replace(/\*$/, '');
      if (!path.startsWith(prefix)) continue;
      if (!best || prefix.length > best.length || (prefix.length === best.length && r.allow))
        best = { allow: r.allow, length: prefix.length };
    }
  }
  return best ? best.allow : true;
}

// ---- links the crawler never follows -----------------------------------------------------

// A link that asks for agreement before it leads anywhere is a gate, not a page: the
// crawler does not accept terms on anyone's behalf.
const CONSENT_GATE =
  /\b(i agree|agree and continue|accept (the )?terms|accept and continue|by continuing|acceptér|acceptere (vilkår|betingelser)|jeg accepterer|fortsæt og accepter|ich stimme zu|zustimmen und fortfahren|akzeptieren und fortfahren|einverstanden)\b/i;
export const consentGate = (text: string): boolean => CONSENT_GATE.test(text);

// ---- the central limiter ---------------------------------------------------------------------

// The registrable part of a host, near enough: the last two labels, or three where the
// second-last is a public second level such as co.uk.
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'ac', 'edu', 'or', 'ne']);
export function domainOf(host: string): string {
  const labels = host.toLowerCase().replace(/\.$/, '').split('.');
  if (labels.length <= 2) return labels.join('.');
  const second = labels[labels.length - 2]!;
  const tld = labels[labels.length - 1]!;
  return tld.length === 2 && SECOND_LEVEL.has(second!)
    ? labels.slice(-3).join('.')
    : labels.slice(-2).join('.');
}

export interface EtiquetteOptions {
  readonly behaviour?: Behaviour;
  readonly limits?: Partial<EtiquetteLimits>;
  // Honour robots.txt for every navigation beyond the page asked for. On by default.
  readonly robots?: boolean;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface NavigationRequest {
  readonly url: string;
  readonly method: string;
  // 'Document' for a navigation; anything else is a sub-resource of a page already allowed.
  readonly resourceType: string;
  // The page the pass was asked for: read whatever robots.txt says, once.
  readonly targetUrl?: string;
  // How to read a host's robots.txt, once; undefined when it has none.
  readonly readRobots?: (url: string) => Promise<string | undefined>;
}

export interface EtiquetteRecord {
  readonly host: string;
  readonly url: string;
  readonly at: string;
}

const WINDOW_MS = 60_000;

export class Etiquette {
  readonly behaviour: Behaviour;
  readonly limits: EtiquetteLimits;
  // Every navigation that waited its turn, in order: the record a test checks.
  readonly navigations: EtiquetteRecord[] = [];
  private readonly lastAt = new Map<string, number>();
  private readonly hostWindow = new Map<string, number[]>();
  private readonly domainWindow = new Map<string, number[]>();
  private readonly hostQueue = new Map<string, Promise<void>>();
  private readonly robots = new Map<string, Promise<string | undefined>>();
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly honourRobots: boolean;

  constructor(options: EtiquetteOptions = {}) {
    this.behaviour = options.behaviour ?? loadBehaviour();
    this.limits = { ...this.behaviour.limits, ...options.limits };
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.honourRobots = options.robots ?? true;
  }

  userAgent(): string {
    return scannerUserAgent(this.behaviour);
  }

  headers(): Record<string, string> {
    return identityHeaders(this.behaviour);
  }

  // The reason a request is refused, or undefined once it may go. A navigation waits
  // its turn per host and per domain before the answer; a sub-resource is never held.
  async judge(request: NavigationRequest): Promise<string | undefined> {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return 'not a URL';
    }
    if (url.username || url.password) return 'credentials in the address';
    if (request.resourceType !== 'Document') return undefined;
    if (request.method.toUpperCase() !== 'GET' && request.method.toUpperCase() !== 'HEAD')
      return 'a form submission';
    const host = url.hostname.toLowerCase();
    const isTarget = request.targetUrl !== undefined && sameUrl(request.targetUrl, request.url);
    if (this.honourRobots && !isTarget && url.pathname !== '/robots.txt' && request.readRobots) {
      const robots = await this.robotsOf(host, `${url.protocol}//${url.host}`, request.readRobots);
      if (
        robots !== undefined &&
        !robotsAllows(robots, url.pathname, scannerUserAgent(this.behaviour))
      )
        return 'robots.txt disallows it';
    }
    await this.turn(host, request.url);
    return undefined;
  }

  private robotsOf(
    host: string,
    origin: string,
    read: (url: string) => Promise<string | undefined>,
  ): Promise<string | undefined> {
    let p = this.robots.get(host);
    if (!p) {
      p = read(`${origin}/robots.txt`).catch(() => undefined);
      this.robots.set(host, p);
    }
    return p;
  }

  // One navigation at a time per host, at least minIntervalMs apart, and no more than
  // the per-minute counts for the host and its domain.
  private turn(host: string, url: string): Promise<void> {
    const previous = this.hostQueue.get(host) ?? Promise.resolve();
    const mine = previous.then(async () => {
      const domain = domainOf(host);
      for (;;) {
        const t = this.now().getTime();
        const last = this.lastAt.get(host);
        const interval = last === undefined ? 0 : last + this.limits.minIntervalMs - t;
        const hostWait = this.windowWait(this.hostWindow, host, t, this.limits.perHostPerMinute);
        const domainWait = this.windowWait(
          this.domainWindow,
          domain,
          t,
          this.limits.perDomainPerMinute,
        );
        const wait = Math.max(interval, hostWait, domainWait);
        if (wait <= 0) {
          this.lastAt.set(host, t);
          this.hostWindow.get(host)!.push(t);
          this.domainWindow.get(domain)!.push(t);
          this.navigations.push({ host, url, at: new Date(t).toISOString() });
          return;
        }
        await this.sleep(wait);
      }
    });
    this.hostQueue.set(
      host,
      mine.catch(() => undefined),
    );
    return mine;
  }

  private windowWait(windows: Map<string, number[]>, key: string, t: number, max: number): number {
    const times = (windows.get(key) ?? []).filter((x) => t - x < WINDOW_MS);
    windows.set(key, times);
    return times.length < max ? 0 : times[0]! + WINDOW_MS - t;
  }
}

const sameUrl = (a: string, b: string): boolean => {
  const norm = (u: string) => {
    try {
      const x = new URL(u);
      x.hash = '';
      return x.toString().replace(/\/$/, '');
    } catch {
      return u;
    }
  };
  return norm(a) === norm(b);
};
