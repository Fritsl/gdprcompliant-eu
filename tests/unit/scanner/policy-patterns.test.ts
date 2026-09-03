import { describe, expect, it } from 'vitest';
import { POLICY_KINDS, PolicyDiscoverySchema } from '@gc/contracts';
import { loadCatalogue } from '@gc/remedies';
import { KIND_PATTERNS, WELL_KNOWN_PATHS, scoreLink } from '@gc/scanner';

const link = (text: string, href: string, extra: Partial<Parameters<typeof scoreLink>[0]> = {}) =>
  scoreLink({ text, href, inFooter: false, ...extra });
const top = (text: string, href: string, extra = {}) =>
  link(text, href, extra).sort((a, b) => b.score - a.score)[0]?.kind;

describe('policy link patterns (S-09)', () => {
  it('recognises the privacy policy in Danish, German, English and friends', () => {
    for (const [text, href] of [
      ['Privatlivspolitik', '/privatliv'],
      ['Persondatapolitik', '/persondata.html'],
      ['Datenschutzerklärung', '/datenschutz'],
      ['Privacy Policy', '/privacy'],
      ['Integritetspolicy', '/integritet'],
      ['Tietosuoja', '/tietosuoja'],
      ['Politique de confidentialité', '/confidentialite'],
      ['Legal', '/legal/privacy-policy'],
    ]) {
      expect(top(text!, href!), `${text} ${href}`).toBe('privacy');
    }
  });

  it('keeps cookies and terms apart from privacy', () => {
    expect(top('Cookiepolitik', '/cookies')).toBe('cookie');
    expect(top('Cookie policy', '/cookie-policy')).toBe('cookie');
    expect(top('Handelsbetingelser', '/betingelser')).toBe('terms');
    expect(top('AGB', '/agb')).toBe('terms');
    expect(top('Terms of Service', '/terms')).toBe('terms');
    // A privacy policy that also mentions cookies is still the privacy policy.
    expect(top('Privatlivs- og cookiepolitik', '/privatliv')).toBe('privacy');
    expect(link('Om os', '/om').length).toBe(0);
  });

  it('rel outranks text, and a footer link outranks the same link elsewhere', () => {
    expect(link('Legal', '/l', { rel: 'privacy-policy' })[0]).toEqual({
      kind: 'privacy',
      score: 100,
      by: 'rel',
    });
    expect(link('Legal', '/l', { rel: 'terms-of-service' })[0]?.kind).toBe('terms');
    const body = link('Privacy', '/privacy')[0]!.score;
    const footer = link('Privacy', '/privacy', { inFooter: true })[0]!.score;
    expect(footer).toBeGreaterThan(body);
  });

  it('well-known paths are short, GET-only, and cover every kind', () => {
    for (const kind of POLICY_KINDS) {
      expect(WELL_KNOWN_PATHS[kind].length).toBeGreaterThan(0);
      expect(WELL_KNOWN_PATHS[kind].length).toBeLessThanOrEqual(10);
      for (const p of WELL_KNOWN_PATHS[kind]) expect(p).toMatch(/^\/[^?#\s]*$/);
      expect(KIND_PATTERNS[kind].text.flags).toContain('i');
    }
  });
});

describe('the no-policy finding (S-09)', () => {
  it('has a remedy, and the discovery shape fails exactly when privacy is missing', () => {
    expect(loadCatalogue().forFinding('POL-01', 'DK')[0]?.remedy.kind).toBe('generated_artefact');
    const base = { site: 'x.test', startedAt: '2026-09-03T00:00:00Z', documents: [], fetched: 3 };
    expect(
      PolicyDiscoverySchema.safeParse({
        ...base,
        missing: ['privacy', 'cookie', 'terms'],
        observation: { findingTypeId: 'POL-01', outcome: 'fail', summary: 'none' },
      }).success,
    ).toBe(true);
    expect(
      PolicyDiscoverySchema.safeParse({
        ...base,
        missing: ['privacy'],
        observation: { findingTypeId: 'POL-01', outcome: 'pass', summary: 'x' },
      }).success,
    ).toBe(false);
  });
});
