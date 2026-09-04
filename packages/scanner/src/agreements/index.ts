import {
  AGREEMENT_FINDINGS,
  AgreementDiscoverySchema,
  EvidenceSchema,
  sha256,
  type AgreementDiscovery,
  type AgreementTrail,
  type Evidence,
  type EvidenceRef,
  type FindingSubject,
  type FindingTypeId,
} from '@gc/contracts';
import { readPage, type PageRead } from '../discovery/policies.js';
import type { LinkCandidate } from '../discovery/patterns.js';
import { refTo, type EvidenceIdentity } from '../evidence.js';
import type { BrowserPool } from '../pool.js';
import { consentGate, scannerUserAgent } from '../etiquette.js';

// Agreement discovery (D-06): does a supplier publish the processing agreement it does
// business under? The supplier's site is read the way a policy is found (S-09): links
// on the home page that look like one, then the paths where such a document lives when
// nothing links to it. Four outcomes, three of them evidenced: found, with the document
// stored; unfindable, when the site promises one but the promise leads to a login, a
// PDF this reader does not open, a dead page or a stub; none, when nothing mentions
// one; unreachable, when the site did not answer, which proves nothing and raises
// nothing. GET only, same site only, a bounded number of pages.

export const AGREEMENT_TEXT =
  /\b(data processing (agreement|addendum|terms)|data protection (agreement|addendum)|processing agreement|processor agreement|\bDPA\b|databehandleraftale|databehandlingsaftale|databehandleraftalen|auftragsverarbeitung|auftragsverarbeitungsvertrag|\bAVV\b|AV-Vertrag|vereinbarung zur auftragsverarbeitung)/i;
export const AGREEMENT_PATH =
  /\bdpa\b|data-processing|dataprocessing|processing-agreement|processor-agreement|databehandler|auftragsverarbeitung|\bavv\b/i;

// Where the document lives when nothing links to it. Short, GET only, same host only.
export const WELL_KNOWN_AGREEMENT_PATHS: readonly string[] = [
  '/dpa',
  '/legal/dpa',
  '/data-processing-agreement',
  '/legal/data-processing-agreement',
  '/databehandleraftale',
  '/auftragsverarbeitung',
  '/avv',
  '/legal/avv',
];

// The body of an agreement names the two roles; a page that does not is not one.
const AGREEMENT_BODY =
  /\b(processor|controller|databehandler|dataansvarlig|auftragsverarbeiter|verantwortlich)/i;
const LOGIN_WALL = /\b(log ?in|sign in|password|adgangskode|anmelden|passwort|einloggen)\b/i;

export const DEFAULT_MIN_WORDS = 200;

export function scoreAgreementLink(link: LinkCandidate): number {
  let path = '';
  try {
    path = decodeURIComponent(new URL(link.href, 'http://x.invalid').pathname);
  } catch {
    path = link.href;
  }
  const text = link.text.replace(/\s+/g, ' ').trim();
  if (consentGate(text)) return 0;
  let score = 0;
  if (AGREEMENT_TEXT.test(text)) score += 10;
  if (AGREEMENT_PATH.test(path)) score += 5;
  if (score === 0) return 0;
  if (link.inFooter) score += 2;
  if (text.length > 60) score -= 3;
  return score;
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
const isPdf = (url: string) => /\.pdf(?:[?#]|$)/i.test(url);

function evidenceRow(
  identity: EvidenceIdentity,
  kind: Evidence['kind'],
  body: string,
  source: Evidence['source'],
  caption: string,
): Evidence {
  const hash = sha256(body);
  return EvidenceSchema.parse({
    id: `${kind}:${hash.slice(0, 16)}`,
    tenantId: identity.tenantId,
    caseId: identity.caseId,
    ...(identity.scanId !== undefined ? { scanId: identity.scanId } : {}),
    kind,
    capturedAt: identity.capturedAt,
    source,
    body,
    hash,
    caption,
  });
}

export interface AgreementDiscoveryOptions {
  readonly identity: EvidenceIdentity;
  // What the supplier is called, for the summary; the host stands in when absent.
  readonly vendorName?: string;
  readonly maxPages?: number;
  readonly minWords?: number;
  readonly now?: () => Date;
}

export interface AgreementDiscoveryResult {
  readonly discovery: AgreementDiscovery;
  readonly evidence: Evidence[];
}

export async function discoverAgreement(
  pool: BrowserPool,
  target: { readonly url: string },
  options: AgreementDiscoveryOptions,
): Promise<AgreementDiscoveryResult> {
  const { identity } = options;
  const maxPages = options.maxPages ?? 8;
  const minWords = options.minWords ?? DEFAULT_MIN_WORDS;
  const now = options.now ?? (() => new Date());
  const site = new URL(target.url).hostname.toLowerCase();
  const startedAt = now().toISOString();
  const vendor = { host: site, ...(options.vendorName ? { name: options.vendorName } : {}) };
  const name = options.vendorName ?? site;

  return pool.run({ userAgent: scannerUserAgent(), ...target }, async (page) => {
    const evidence: Evidence[] = [];
    const trail: AgreementTrail[] = [];
    let fetched = 0;
    const visited = new Set<string>();

    const fetchPage = async (url: string): Promise<PageRead | undefined> => {
      const key = url.replace(/#(?!\/).*$/, '').replace(/\/$/, '');
      if (visited.has(key) || fetched >= maxPages || !sameSite(site, url)) return undefined;
      visited.add(key);
      fetched++;
      return readPage(page, url);
    };

    const finish = (
      outcome: AgreementDiscovery['outcome'],
      summary: string,
      extra: Partial<AgreementDiscovery> = {},
    ): AgreementDiscoveryResult => ({
      discovery: AgreementDiscoverySchema.parse({
        vendor,
        startedAt,
        fetched,
        outcome,
        trail,
        summary,
        evidence: evidence.map((e) => refTo(e)),
        ...extra,
      }),
      evidence,
    });

    const home = await fetchPage(target.url);
    if (!home || home.status >= 500) {
      return finish(
        'unreachable',
        `${name} (${site}) did not answer, so nothing is known of its processing agreement.`,
      );
    }

    // A page that reads as the agreement: long enough, and about a processor and a
    // controller. Anything else that a link promised is a trail entry.
    const accept = (
      r: PageRead,
      url: string,
      foundBy: 'link' | 'well-known',
    ): AgreementDiscoveryResult | undefined => {
      const words = wordCount(r.text);
      if (r.status >= 400) {
        trail.push({ url, status: r.status, reason: `answered ${r.status}` });
        return undefined;
      }
      if (words < minWords) {
        trail.push({
          url,
          status: r.status,
          reason: LOGIN_WALL.test(r.text)
            ? `behind a login (${words} words visible)`
            : `too short to be an agreement (${words} words)`,
        });
        return undefined;
      }
      if (!AGREEMENT_BODY.test(r.text)) {
        trail.push({ url, status: r.status, reason: 'names neither a processor nor a controller' });
        return undefined;
      }
      const row = evidenceRow(
        identity,
        'document',
        r.text,
        { url: r.finalUrl, host: new URL(r.finalUrl).hostname },
        `processing agreement of ${name} at ${r.finalUrl}${r.lang ? ` (${r.lang})` : ''}`,
      );
      evidence.push(row);
      return finish(
        'found',
        `${name} publishes a processing agreement at ${r.finalUrl} (${words} words).`,
        {
          document: {
            url,
            finalUrl: r.finalUrl,
            ...(r.title ? { title: r.title } : {}),
            ...(r.lang ? { language: r.lang } : {}),
            words,
            foundBy,
            evidence: refTo(row),
          },
        },
      );
    };

    // 1. Links on the home page that look like the agreement, best first.
    const candidates = home.links
      .map((l) => ({ link: l, score: scoreAgreementLink(l) }))
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 4);
    for (const { link } of candidates) {
      if (!sameSite(site, link.href)) {
        trail.push({ url: link.href, reason: 'leads off the site' });
        continue;
      }
      if (isPdf(link.href)) {
        trail.push({ url: link.href, reason: 'a PDF, which this reader does not open' });
        continue;
      }
      const before = fetched;
      const r = await fetchPage(link.href);
      if (!r) {
        if (fetched > before)
          trail.push({ url: link.href, reason: 'answered an error or nothing' });
        continue;
      }
      const found = accept(r, link.href, 'link');
      if (found) return found;
    }

    // 2. Well-known paths, only when no link led anywhere.
    for (const path of WELL_KNOWN_AGREEMENT_PATHS) {
      const url = new URL(path, target.url).toString();
      const r = await fetchPage(url);
      if (!r || r.status >= 400) continue;
      const found = accept(r, url, 'well-known');
      if (found) return found;
    }

    const promised = candidates.length > 0 || AGREEMENT_TEXT.test(home.text);
    const homeRow = evidenceRow(
      identity,
      'document',
      home.text,
      { url: home.finalUrl, host: new URL(home.finalUrl).hostname },
      `home page of ${site}, searched for a processing agreement: ${fetched} page(s) fetched, none was one`,
    );
    evidence.push(homeRow);
    if (!promised) {
      return finish(
        'none',
        `${name} (${site}) publishes no processing agreement: nothing on its site mentions one (${fetched} page(s) read).`,
      );
    }
    const trailText =
      trail.map((t) => `${t.url}: ${t.reason}`).join('\n') || 'the mention led to no link';
    const trailRow = evidenceRow(
      identity,
      'text',
      trailText,
      { host: site },
      `where the promised processing agreement of ${name} led`,
    );
    evidence.push(trailRow);
    return finish(
      'unfindable',
      `${name} (${site}) mentions a processing agreement, but it could not be read: ${trail.map((t) => t.reason).join('; ') || 'no link leads to it'}.`,
    );
  });
}

// The finding a discovery outcome raises, as a draft for assembly (S-14), about the
// scanned site and naming the supplier. Found raises nothing until the document is
// read (D-06 analysis); unreachable raises nothing at all.
export interface AgreementDraft {
  readonly typeId: FindingTypeId;
  readonly subject: FindingSubject;
  readonly evidence: readonly EvidenceRef[];
  readonly hosts: readonly string[];
  readonly summary: string;
}

export function agreementDraft(
  result: AgreementDiscoveryResult,
  host: string,
): AgreementDraft | undefined {
  const d = result.discovery;
  const vendor = d.vendor.name ?? d.vendor.host;
  if (d.outcome === 'none')
    return {
      typeId: AGREEMENT_FINDINGS.none as FindingTypeId,
      subject: { host },
      evidence: d.evidence,
      hosts: [d.vendor.host],
      summary: `${vendor} processes personal data for ${host}, and nothing on its site offers a processing agreement.`,
    };
  if (d.outcome === 'unfindable')
    return {
      typeId: AGREEMENT_FINDINGS.unfindable as FindingTypeId,
      subject: { host },
      evidence: d.evidence,
      hosts: [d.vendor.host],
      summary: `${vendor} mentions a processing agreement, but it could not be read: ${d.trail.map((t) => t.reason).join('; ') || 'no link leads to it'}.`,
    };
  return undefined;
}
