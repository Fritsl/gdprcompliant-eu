import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { BrowserContext, CDPSession, Page } from 'playwright';

// Where the browser may not go (T-06). A scanned page is attacker-controlled and can
// point the browser anywhere: at the machine it runs on, at the private network behind
// it, at a cloud metadata service, at a file. None of that is a website, so none of it is
// fetched: the request is refused before it leaves, and the refusal is on the pass's own
// record. A name that resolves to a private address is refused the same way. Redirects
// are judged hop by hop: a public page that bounces into the network stops at the bounce.

const PRIVATE_HOSTS = new Set(['localhost', 'localhost.localdomain', 'metadata.google.internal']);
const PRIVATE_SUFFIXES = ['.localhost', '.internal', '.local', '.home.arpa', '.intranet', '.corp'];

function privateV4(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
  const [a, b] = p as [number, number, number, number];
  return (
    a === 0 || // this network
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, and every cloud metadata service
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) || // IETF protocol assignments, 192.0.0.0/24 and 192.0.2.0/24
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast and reserved
  );
}

function privateV6(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (v === '::' || v === '::1') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (mapped) return privateV4(mapped[1]!);
  const head = Number.parseInt(v.split(':')[0] || '0', 16);
  return (
    (head & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (head & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (head & 0xff00) === 0xff00 || // multicast
    head === 0
  );
}

export function privateAddress(ip: string): boolean {
  const kind = isIP(ip.replace(/^\[|\]$/g, ''));
  if (kind === 4) return privateV4(ip);
  if (kind === 6) return privateV6(ip);
  return false;
}

// Why a URL may not be fetched, or nothing when it may. Names are judged as names here;
// what they resolve to is judged in the guard, which can wait for DNS.
export function forbiddenTarget(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'not a URL';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return `scheme ${url.protocol} is not the web`;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host.length === 0) return 'no host';
  if (PRIVATE_HOSTS.has(host)) return `${host} is this machine`;
  if (PRIVATE_SUFFIXES.some((s) => host.endsWith(s))) return `${host} is a private name`;
  if (isIP(host.replace(/^\[|\]$/g, ''))) {
    return privateAddress(host)
      ? `${host} is a private address`
      : `${host} is an address, not a site`;
  }
  return undefined;
}

export interface Blocked {
  readonly url: string;
  readonly reason: string;
}

export interface EgressGuardOptions {
  // Resolve names and refuse ones that point at private addresses. On by default; off
  // for estates whose names do not resolve at all (the fixture proxy answers them).
  readonly resolve?: boolean;
}

// One guard per context: the verdicts it reached and what it refused.
export class EgressGuard {
  readonly blocked: Blocked[] = [];
  private readonly resolved = new Map<string, Promise<string | undefined>>();

  constructor(private readonly options: EgressGuardOptions = {}) {}

  private resolvesPrivately(host: string): Promise<string | undefined> {
    let p = this.resolved.get(host);
    if (!p) {
      p = lookup(host, { all: true }).then(
        (addresses) => {
          const bad = addresses.find((a) => privateAddress(a.address));
          return bad ? `${host} resolves to ${bad.address}, a private address` : undefined;
        },
        // A name that does not resolve reaches nothing; the network will say so.
        () => undefined,
      );
      this.resolved.set(host, p);
    }
    return p;
  }

  async judge(url: string): Promise<string | undefined> {
    const reason = forbiddenTarget(url);
    if (reason) return reason;
    if (this.options.resolve === false) return undefined;
    const host = new URL(url).hostname.toLowerCase();
    return isIP(host) ? undefined : this.resolvesPrivately(host);
  }

  // Chromium: every request, redirect hops included, is paused at the request stage
  // and judged before it leaves. Returns false where the protocol is not available.
  async attach(context: BrowserContext, page: Page): Promise<boolean> {
    let session: CDPSession;
    try {
      session = await context.newCDPSession(page);
    } catch {
      return false;
    }
    session.on('Fetch.requestPaused', (event: { requestId: string; request: { url: string } }) => {
      void (async () => {
        const reason = await this.judge(event.request.url);
        if (reason) {
          this.blocked.push({ url: event.request.url, reason });
          await session
            .send('Fetch.failRequest', {
              requestId: event.requestId,
              errorReason: 'BlockedByClient',
            })
            .catch(() => undefined);
        } else {
          await session
            .send('Fetch.continueRequest', { requestId: event.requestId })
            .catch(() => undefined);
        }
      })();
    });
    try {
      await session.send('Fetch.enable', {
        patterns: [{ urlPattern: '*', requestStage: 'Request' }],
      });
    } catch {
      return false;
    }
    return true;
  }

  // Any browser: the same judgement through the page router, which does not see
  // redirect hops. Used where the request stage cannot be reached.
  async fallback(context: BrowserContext): Promise<void> {
    await context.route('**/*', async (route, request) => {
      const url = request.url();
      const reason = await this.judge(url);
      if (reason) {
        this.blocked.push({ url, reason });
        await route.abort('blockedbyclient').catch(() => undefined);
        return;
      }
      await route.continue().catch(() => undefined);
    });
  }
}

// Install the guard on a context and its first page, and on every page it opens later.
export async function guardContext(
  context: BrowserContext,
  page: Page,
  options: EgressGuardOptions = {},
): Promise<EgressGuard> {
  const guard = new EgressGuard(options);
  const attached = await guard.attach(context, page);
  if (attached) {
    context.on('page', (opened) => {
      void guard.attach(context, opened);
    });
  } else {
    await guard.fallback(context);
  }
  return guard;
}
