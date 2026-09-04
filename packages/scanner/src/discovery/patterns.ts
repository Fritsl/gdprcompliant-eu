import type { PolicyKind } from '@gc/contracts';
import { consentGate } from '../etiquette.js';

// How a policy link looks, in the languages the product meets. A link is scored on its
// text and its path; the highest score per kind wins. Patterns are data: extend them
// here, and the unit test tells you whether a new phrase collides with another kind.
//
// Leading word boundary only: Danish and German compound freely ("Privatlivspolitik",
// "Datenschutzhinweise"), so a stem match is the right test.

const PRIVACY_TEXT =
  /\b(privatliv|persondata|personoplysning|databeskyttelse|privacy|datenschutz|integritet|personvern|tietosuoja|confidentialit|vie priv|privacidad|gdpr)/i;
const PRIVACY_PATH =
  /privat|privacy|persondata|datenschutz|integritet|personvern|tietosuoja|confidentialite|privacidad|gdpr/i;

const COOKIE_TEXT = /\b(cookie|kager)/i;
const COOKIE_PATH = /cookie/i;

const TERMS_TEXT =
  /\b(vilk[åa]r|betingelser|terms|agb\b|nutzungsbedingungen|gesch[äa]ftsbedingungen|conditions g[ée]n|villkor|k[äa]ytt[öo]ehdot)/i;
const TERMS_PATH = /vilkaar|vilkar|betingelser|terms|agb|bedingungen|conditions|villkor/i;

export const KIND_PATTERNS: Record<PolicyKind, { text: RegExp; path: RegExp }> = {
  privacy: { text: PRIVACY_TEXT, path: PRIVACY_PATH },
  cookie: { text: COOKIE_TEXT, path: COOKIE_PATH },
  terms: { text: TERMS_TEXT, path: TERMS_PATH },
};

// The rel values the HTML standard reserves for exactly this.
export const REL_KINDS: Record<string, PolicyKind> = {
  'privacy-policy': 'privacy',
  'terms-of-service': 'terms',
};

// Where a policy lives when nothing links to it. Short, GET only, same host only.
export const WELL_KNOWN_PATHS: Record<PolicyKind, readonly string[]> = {
  privacy: [
    '/privacy',
    '/privacy-policy',
    '/privacy/',
    '/privatlivspolitik',
    '/privatliv',
    '/persondatapolitik',
    '/datenschutz',
    '/datenschutzerklaerung',
    '/.well-known/privacy-policy',
  ],
  cookie: ['/cookies', '/cookie-policy', '/cookiepolitik', '/cookie-erklaerung'],
  terms: ['/terms', '/terms-of-service', '/handelsbetingelser', '/vilkaar', '/agb'],
};

export interface LinkCandidate {
  readonly href: string;
  readonly text: string;
  readonly rel?: string;
  readonly hreflang?: string;
  readonly inFooter: boolean;
}

export interface Scored {
  readonly kind: PolicyKind;
  readonly score: number;
  readonly by: 'rel' | 'link';
}

// A cookie policy is a specific thing; a privacy policy that mentions cookies in its
// title is still a privacy policy. Text outranks path, rel outranks both, footer adds.
export function scoreLink(link: LinkCandidate): Scored[] {
  const out: Scored[] = [];
  const rel = (link.rel ?? '')
    .toLowerCase()
    .split(/\s+/)
    .find((r) => r in REL_KINDS);
  if (rel) out.push({ kind: REL_KINDS[rel]!, score: 100, by: 'rel' });

  let path = '';
  try {
    path = decodeURIComponent(new URL(link.href, 'http://x.invalid').pathname);
  } catch {
    path = link.href;
  }
  const text = link.text.replace(/\s+/g, ' ').trim();
  // A link that asks for agreement first is a gate the crawler does not pass (D-11).
  if (consentGate(text)) return out;
  for (const kind of ['cookie', 'privacy', 'terms'] as const) {
    const p = KIND_PATTERNS[kind];
    let score = 0;
    if (p.text.test(text)) score += 10;
    if (p.path.test(path)) score += 5;
    if (score === 0) continue;
    // "Cookie" in the text of a privacy link, or vice versa: the more specific kind wins.
    if (kind === 'privacy' && COOKIE_TEXT.test(text) && !PRIVACY_TEXT.test(text)) continue;
    if (link.inFooter) score += 2;
    if (text.length > 60) score -= 3;
    out.push({ kind, score, by: 'link' });
  }
  return out;
}
