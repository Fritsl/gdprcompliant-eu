import {
  EvidenceSchema,
  NO_PRIVACY_POLICY_FINDING,
  POLICY_KINDS,
  PolicyDiscoverySchema,
  sha256,
  type Evidence,
  type EvidenceRef,
  type PolicyDiscovery,
  type PolicyDocument,
  type PolicyKind,
  type PolicyPage,
} from '@gc/contracts';
import type { Page } from 'playwright';
import { refTo, type EvidenceIdentity } from '../evidence.js';
import type { BrowserPool, ScanTarget } from '../pool.js';
import { KIND_PATTERNS, WELL_KNOWN_PATHS, scoreLink, type LinkCandidate } from './patterns.js';

// Find the privacy policy, the cookie policy and the terms, the way a visitor would:
// the links on the home page first (rel hints, then link text and path in any language
// we know), then a short list of well-known paths. A found policy is read for its own
// sub-pages and language variants, one level deep, same site only. Every page fetched
// becomes document evidence: URL, time, and the hash of the text the reader saw.

export interface DiscoveryOptions {
  readonly identity: EvidenceIdentity;
  // Fetch budget for the whole site. GET only, same site only.
  readonly maxPages?: number;
  readonly now?: () => Date;
}

interface PageRead {
  readonly finalUrl: string;
  readonly status: number;
  readonly lang?: string;
  readonly title?: string;
  readonly text: string;
  readonly links: LinkCandidate[];
  readonly alternates: { hreflang: string; href: string }[];
}

const READ_PAGE = `(() => {
  const inFooter = (el) => !!el.closest('footer, [role="contentinfo"], .footer, #footer');
  const links = Array.from(document.querySelectorAll('a[href]')).slice(0, 2000).map((a) => ({
    href: a.href,
    text: (a.textContent || '').trim().slice(0, 200) || (a.getAttribute('aria-label') || '').trim() || (a.getAttribute('title') || '').trim(),
    rel: a.getAttribute('rel') || undefined,
    hreflang: a.getAttribute('hreflang') || undefined,
    inFooter: inFooter(a),
  }));
  for (const l of Array.from(document.querySelectorAll('link[rel][href]'))) {
    links.push({ href: l.href, text: '', rel: l.getAttribute('rel') || undefined, hreflang: l.getAttribute('hreflang') || undefined, inFooter: false });
  }
  const alternates = Array.from(document.querySelectorAll('link[rel="alternate"][hreflang][href]')).map((l) => ({ hreflang: l.getAttribute('hreflang'), href: l.href }));
  return {
    lang: document.documentElement.getAttribute('lang') || undefined,
    title: document.title || undefined,
    // Bounded (T-06): a page can be as big as it likes; what is kept is not.
    text: ((document.body && document.body.innerText) || '').slice(0, 400000),
    links,
    alternates,
  };
})()`;

async function read(page: Page, url: string): Promise<PageRead | undefined> {
  let status = 0;
  try {
    const response = await page.goto(url, { waitUntil: 'load' });
    status = response?.status() ?? 0;
    if (status >= 400 || status === 0) return undefined;
  } catch {
    return undefined;
  }
  const seen = (await page.evaluate(READ_PAGE)) as Omit<PageRead, 'finalUrl' | 'status'>;
  return { ...seen, finalUrl: page.url(), status };
}

function sameSite(site: string, url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  const bare = site.replace(/^www\./, '');
  return host === site || host === bare || host.endsWith(`.${bare}`);
}

const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;

export async function discoverPolicies(
  pool: BrowserPool,
  target: ScanTarget,
  options: DiscoveryOptions,
): Promise<{ discovery: PolicyDiscovery; evidence: Evidence[] }> {
  const { identity } = options;
  const maxPages = options.maxPages ?? 12;
  const now = options.now ?? (() => new Date());
  const site = new URL(target.url).hostname.toLowerCase();
  const startedAt = now().toISOString();

  return pool.run(target, async (page) => {
    const evidence: Evidence[] = [];
    let fetched = 0;
    const visited = new Set<string>();

    const record = (
      kind: PolicyKind,
      r: PageRead,
      url: string,
      foundBy: PolicyPage['foundBy'],
    ): PolicyPage => {
      const body = r.text;
      const hash = sha256(body);
      const row = EvidenceSchema.parse({
        id: `document:${hash.slice(0, 16)}`,
        tenantId: identity.tenantId,
        caseId: identity.caseId,
        ...(identity.scanId !== undefined ? { scanId: identity.scanId } : {}),
        kind: 'document',
        capturedAt: identity.capturedAt,
        source: { url: r.finalUrl, host: new URL(r.finalUrl).hostname },
        body,
        hash,
        caption: `${kind} policy at ${r.finalUrl}${r.lang ? ` (${r.lang})` : ''}`,
      });
      if (!evidence.some((e) => e.hash === row.hash)) evidence.push(row);
      return {
        url,
        finalUrl: r.finalUrl,
        status: r.status,
        ...(r.lang ? { language: r.lang } : {}),
        ...(r.title ? { title: r.title } : {}),
        fetchedAt: now().toISOString(),
        textHash: hash,
        words: wordCount(body),
        foundBy,
        evidence: refTo(row),
      };
    };

    const fetchPage = async (url: string): Promise<PageRead | undefined> => {
      const key = url.replace(/#.*$/, '').replace(/\/$/, '');
      if (visited.has(key) || fetched >= maxPages || !sameSite(site, url)) return undefined;
      visited.add(key);
      fetched++;
      return read(page, url);
    };

    const home = await fetchPage(target.url);
    const documents: PolicyDocument[] = [];
    const found = new Map<PolicyKind, PolicyDocument>();

    // 1. Links on the home page, best score per kind.
    const best = new Map<PolicyKind, { href: string; score: number; by: 'rel' | 'link' }>();
    for (const link of home?.links ?? []) {
      if (!sameSite(site, link.href)) continue;
      for (const s of scoreLink(link)) {
        const current = best.get(s.kind);
        if (!current || s.score > current.score)
          best.set(s.kind, { href: link.href, score: s.score, by: s.by });
      }
    }

    for (const kind of POLICY_KINDS) {
      const candidate = best.get(kind);
      let entry: { read: PageRead; url: string; by: PolicyPage['foundBy'] } | undefined;
      if (candidate) {
        const r = await fetchPage(candidate.href);
        if (r && wordCount(r.text) > 30) entry = { read: r, url: candidate.href, by: candidate.by };
      }
      // 2. Well-known paths, only when no link led anywhere.
      if (!entry) {
        for (const path of WELL_KNOWN_PATHS[kind]) {
          const url = new URL(path, target.url).toString();
          const r = await fetchPage(url);
          if (
            r &&
            wordCount(r.text) > 30 &&
            (KIND_PATTERNS[kind].text.test(r.title ?? '') ||
              KIND_PATTERNS[kind].text.test(r.text.slice(0, 400)))
          ) {
            entry = { read: r, url, by: 'well-known' };
            break;
          }
        }
      }
      if (!entry) continue;

      const pages: PolicyPage[] = [record(kind, entry.read, entry.url, entry.by)];
      // 3. One level deeper: sub-pages of the same kind, and language variants.
      const more: { href: string; by: PolicyPage['foundBy'] }[] = [];
      for (const alt of entry.read.alternates) more.push({ href: alt.href, by: 'alternate' });
      for (const link of entry.read.links) {
        if (link.hreflang) {
          more.push({ href: link.href, by: 'alternate' });
          continue;
        }
        const scores = scoreLink(link).filter((s) => s.kind === kind && s.score >= 10);
        if (scores.length > 0) more.push({ href: link.href, by: 'subpage' });
      }
      for (const m of more.slice(0, 6)) {
        const r = await fetchPage(m.href);
        if (r && wordCount(r.text) > 30 && r.finalUrl !== entry.read.finalUrl) {
          pages.push(record(kind, r, m.href, m.by));
        }
      }
      const doc = { kind, pages };
      documents.push(doc);
      found.set(kind, doc);
    }

    const missing = POLICY_KINDS.filter((k) => !found.has(k));
    const privacy = found.get('privacy');
    // A missing policy is evidenced by what was searched: the home page as read, so the
    // finding points at something a hash can vouch for.
    const searched: EvidenceRef[] = [];
    if (!privacy && home) {
      const body = home.text;
      const hash = sha256(body);
      const row = EvidenceSchema.parse({
        id: `document:${hash.slice(0, 16)}`,
        tenantId: identity.tenantId,
        caseId: identity.caseId,
        ...(identity.scanId !== undefined ? { scanId: identity.scanId } : {}),
        kind: 'document',
        capturedAt: identity.capturedAt,
        source: { url: home.finalUrl, host: new URL(home.finalUrl).hostname },
        body,
        hash,
        caption: `home page of ${site}, searched for a privacy policy: ${fetched} page(s) fetched, none was one`,
      });
      if (!evidence.some((e) => e.hash === row.hash)) evidence.push(row);
      searched.push(refTo(row));
    }
    const discovery = PolicyDiscoverySchema.parse({
      site,
      startedAt,
      documents,
      missing,
      fetched,
      observation: privacy
        ? {
            findingTypeId: NO_PRIVACY_POLICY_FINDING,
            outcome: 'pass',
            summary: `Privacy policy found at ${privacy.pages[0]!.finalUrl}${privacy.pages.length > 1 ? ` and ${privacy.pages.length - 1} more page(s)` : ''}.`,
            evidence: privacy.pages.map((p) => p.evidence),
          }
        : {
            findingTypeId: NO_PRIVACY_POLICY_FINDING,
            outcome: 'fail',
            summary: `No privacy policy could be found on ${site}: nothing on the home page links to one, and none of the ${WELL_KNOWN_PATHS.privacy.length} usual addresses answers with one.`,
            evidence: searched,
          },
    });
    return { discovery, evidence };
  });
}
