import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';
import { z } from 'zod';
import {
  CountryCodeSchema,
  EvidenceSchema,
  VendorRoleSchema,
  VendorSchema,
  sha256,
  type Evidence,
  type Vendor,
} from '@gc/contracts';
import { readPage, type LinkCandidate } from '../discovery/policies.js';
import { refTo, type EvidenceIdentity } from '../evidence.js';
import type { BrowserPool, ScanTarget } from '../pool.js';
import { entityFields, vendorMaps, type VendorMaps } from '../vendors/resolve.js';

// Job adverts (D-04): a company tells the public which tools it runs when it hires for
// them. The adverts are found from the site's own careers page and read only where
// they are public: same site, no login. A tool is claimed only when one of its names
// appears as written; nothing is inferred from a job title or a skill. Every candidate
// carries the advert it came from, with its address and date, as evidence.

export const ToolSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  label: z.string().min(1),
  names: z.array(z.string().min(2)).min(1),
  caseSensitive: z.boolean().default(false),
  role: VendorRoleSchema,
  vendorId: z.string().optional(),
  country: CountryCodeSchema.optional(),
});
export type Tool = z.infer<typeof ToolSchema>;
export const ToolMapSchema = z.object({
  version: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  tools: z.array(ToolSchema).min(1),
});
export type ToolMap = z.infer<typeof ToolMapSchema>;

export const TOOLS_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../data/adverts/tools.json',
);
export function loadToolMap(file: string = TOOLS_FILE): ToolMap {
  return ToolMapSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}

export interface AdvertPage {
  readonly url: string;
  readonly title?: string | undefined;
  readonly text: string;
  // The date the advert says it was posted, when it says one.
  readonly postedAt?: string | undefined;
  readonly fetchedAt: string;
  readonly status: number;
  // The page asked for a password: not public, not read.
  readonly requiresLogin: boolean;
}

export interface ToolMention {
  readonly toolId: string;
  // The name as written in the advert.
  readonly name: string;
  readonly quote: string;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A name counts when it stands on its own: not inside another word.
const nameRegex = (name: string, caseSensitive: boolean) =>
  new RegExp(`(?<![\\p{L}\\p{N}])${escape(name)}(?![\\p{L}\\p{N}])`, caseSensitive ? 'u' : 'iu');

const quoteAround = (text: string, at: number, length: number): string => {
  const start = Math.max(0, at - 60);
  const end = Math.min(text.length, at + length + 60);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`;
};

// Every tool named in the text, once each, with the words around the first mention.
export function extractTools(text: string, tools: readonly Tool[]): ToolMention[] {
  const out: ToolMention[] = [];
  for (const tool of tools) {
    for (const name of tool.names) {
      const m = nameRegex(name, tool.caseSensitive).exec(text);
      if (!m) continue;
      out.push({ toolId: tool.id, name: m[0], quote: quoteAround(text, m.index, m[0].length) });
      break;
    }
  }
  return out;
}

export interface AdvertCandidates {
  readonly candidates: readonly Vendor[];
  readonly evidence: readonly Evidence[];
  readonly mentions: readonly { readonly url: string; readonly mention: ToolMention }[];
  readonly skipped: readonly { readonly url: string; readonly reason: string }[];
}

export interface AdvertCandidateOptions {
  readonly domain: string;
  readonly tools?: ToolMap | undefined;
  readonly maps?: VendorMaps | undefined;
}

// A posting date as the advert gives it, as an instant; a bare date is its midnight, UTC.
const isoDate = (d: string | undefined): string | undefined => {
  if (!d) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return `${d}T00:00:00.000Z`;
  const t = Date.parse(d);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
};

// Candidate processors from what public adverts name: one per tool, resting on every
// advert that names it, the earliest posting date as when it was seen.
export function advertCandidates(
  adverts: readonly AdvertPage[],
  identity: EvidenceIdentity,
  options: AdvertCandidateOptions,
): AdvertCandidates {
  const tools = options.tools ?? loadToolMap();
  const maps = options.maps ?? vendorMaps();
  const evidence: Evidence[] = [];
  const mentions: { url: string; mention: ToolMention }[] = [];
  const skipped: { url: string; reason: string }[] = [];
  const byTool = new Map<
    string,
    { tool: Tool; refs: ReturnType<typeof refTo>[]; seenAt: string[] }
  >();
  for (const advert of adverts) {
    if (advert.requiresLogin) {
      skipped.push({ url: advert.url, reason: 'behind a login' });
      continue;
    }
    if (advert.status !== 200) {
      skipped.push({ url: advert.url, reason: `HTTP ${advert.status}` });
      continue;
    }
    const found = extractTools(advert.text, tools.tools);
    if (found.length === 0) continue;
    let host = advert.url;
    try {
      host = new URL(advert.url).hostname;
    } catch {
      /* keep the url as the host */
    }
    const body = JSON.stringify(
      {
        url: advert.url,
        ...(advert.title ? { title: advert.title } : {}),
        ...(advert.postedAt ? { postedAt: advert.postedAt } : {}),
        fetchedAt: advert.fetchedAt,
        text: advert.text,
      },
      null,
      2,
    );
    const hash = sha256(body);
    const row = EvidenceSchema.parse({
      id: `document:${hash.slice(0, 16)}`,
      tenantId: identity.tenantId,
      caseId: identity.caseId,
      ...(identity.scanId !== undefined ? { scanId: identity.scanId } : {}),
      kind: 'document',
      capturedAt: identity.capturedAt,
      source: { url: advert.url, host },
      body,
      hash,
      caption: `Job advert at ${advert.url}${advert.postedAt ? `, posted ${advert.postedAt.slice(0, 10)}` : ''}`,
    });
    if (!evidence.some((e) => e.hash === row.hash)) evidence.push(row);
    for (const mention of found) {
      mentions.push({ url: advert.url, mention });
      const tool = tools.tools.find((t) => t.id === mention.toolId)!;
      const entry = byTool.get(tool.id) ?? { tool, refs: [], seenAt: [] };
      entry.refs.push(refTo(row, mention.quote));
      entry.seenAt.push(isoDate(advert.postedAt) ?? advert.fetchedAt);
      byTool.set(tool.id, entry);
    }
  }
  const candidates = [...byTool.values()].map(({ tool, refs, seenAt }) => {
    const registryEntry = tool.vendorId
      ? maps.registry.vendors.find((v) => v.id === tool.vendorId)
      : undefined;
    return VendorSchema.parse({
      id: `vendor:advert:${tool.id}:${options.domain}`,
      tenantId: identity.tenantId,
      caseId: identity.caseId,
      label: tool.label,
      jurisdiction: registryEntry ? registryEntry.contracting.country : (tool.country ?? 'EU'),
      role: tool.role,
      level: 1,
      hosts: [],
      resolution: 'unresolved',
      ...(registryEntry ? entityFields(registryEntry) : {}),
      provenance: {
        source: 'observation',
        registryVersion: `advert-tools@${tools.version}${registryEntry ? `, vendors@${maps.registry.version}` : ''}`,
        seenAt: [...seenAt].sort()[0]!,
        evidence: refs,
      },
    });
  });
  return { candidates, evidence, mentions, skipped };
}

// ---- finding the adverts on the site ------------------------------------------------

const CAREERS_TEXT =
  /\b(careers?|jobs?|vacanc|join us|work (with|for) us|we are hiring|ledige stillinger|job hos|karriere|jobs? bei|offene stellen|stellenangebote)\b/i;
const CAREERS_PATH = /career|jobs?\b|vacanc|stillinger|karriere|stellen/i;
const ADVERT_HINT = /job|stilling|stelle|position|vacanc|apply|ansøg|bewerb/i;

export function careersLinks(links: readonly LinkCandidate[], site: string): string[] {
  const out: string[] = [];
  for (const l of links) {
    if (!sameSite(site, l.href)) continue;
    if (CAREERS_TEXT.test(l.text) || CAREERS_PATH.test(pathOf(l.href))) out.push(l.href);
  }
  return [...new Set(out)];
}

const pathOf = (url: string): string => {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
};

function sameSite(site: string, url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === site || host.endsWith(`.${site}`) || site.endsWith(`.${host}`);
}

// What the page says about itself: a posting date, and whether it wants a password.
const ADVERT_META = `(() => {
  const time = document.querySelector('time[datetime]');
  let posted = time ? time.getAttribute('datetime') : null;
  if (!posted) {
    for (const s of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
      const m = /"datePosted"\\s*:\\s*"([^"]+)"/.exec(s.textContent || '');
      if (m) { posted = m[1]; break; }
    }
  }
  return {
    posted,
    requiresLogin: !!document.querySelector('input[type="password"]'),
  };
})()`;

export interface DiscoverAdvertsOptions {
  readonly identity: EvidenceIdentity;
  readonly maxPages?: number;
  readonly now?: () => Date;
}

export interface AdvertDiscovery {
  readonly careersUrl?: string | undefined;
  readonly adverts: readonly AdvertPage[];
  readonly pagesRead: number;
}

// The careers page from the home page's links, then the adverts it links to, same site
// only, GET only, a bounded number of pages. A page that asks for a password is kept
// as such and never read as an advert.
export async function discoverAdverts(
  pool: BrowserPool,
  target: ScanTarget,
  options: DiscoverAdvertsOptions,
): Promise<AdvertDiscovery> {
  const maxPages = options.maxPages ?? 15;
  const now = options.now ?? (() => new Date());
  const site = new URL(target.url).hostname.toLowerCase();
  return pool.run(target, async (page: Page) => {
    let pagesRead = 0;
    const home = await readPage(page, target.url);
    pagesRead++;
    if (!home) return { adverts: [], pagesRead };
    const careers = careersLinks(home.links, site)[0];
    if (!careers) return { adverts: [], pagesRead };
    const list = await readPage(page, careers);
    pagesRead++;
    if (!list) return { careersUrl: careers, adverts: [], pagesRead };
    const candidates = [
      ...new Set(
        list.links
          .filter((l) => sameSite(site, l.href))
          .filter((l) => ADVERT_HINT.test(l.text) || ADVERT_HINT.test(pathOf(l.href)))
          .map((l) => l.href.replace(/#.*$/, ''))
          .filter((href) => href !== careers.replace(/#.*$/, '')),
      ),
    ];
    const adverts: AdvertPage[] = [];
    for (const url of candidates) {
      if (pagesRead >= maxPages) break;
      const r = await readPage(page, url);
      pagesRead++;
      if (!r) {
        adverts.push({
          url,
          text: '',
          fetchedAt: now().toISOString(),
          status: 0,
          requiresLogin: false,
        });
        continue;
      }
      const meta = (await page.evaluate(ADVERT_META)) as {
        posted: string | null;
        requiresLogin: boolean;
      };
      adverts.push({
        url: r.finalUrl,
        ...(r.title ? { title: r.title } : {}),
        text: meta.requiresLogin ? '' : r.text,
        ...(meta.posted ? { postedAt: meta.posted } : {}),
        fetchedAt: now().toISOString(),
        status: r.status,
        requiresLogin: meta.requiresLogin,
      });
    }
    return { careersUrl: careers, adverts, pagesRead };
  });
}
