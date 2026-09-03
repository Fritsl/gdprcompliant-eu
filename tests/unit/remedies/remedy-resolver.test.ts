import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RenderedRemedySchema, SUPPORTED_JURISDICTIONS, type Remedy } from '@gc/contracts';
import {
  Catalogue,
  FALLBACK_REMEDY_ID,
  MIN_PARTNER_OPTIONS,
  costOf,
  entryHash,
  fill,
  loadCatalogue,
  resolveRemedy,
  type ResolveContext,
} from '@gc/remedies';

const catalogue = loadCatalogue();
const fixture = JSON.parse(
  readFileSync(new URL('../../../fixtures/companies/eksempelbutik.json', import.meta.url), 'utf8'),
) as { findings: { id: string }[]; newInWatch: { id: string } };
const fixtureTypes = [...fixture.findings, fixture.newInWatch].map((f) => f.id);

// Everything the seed templates can ask for, as the case would supply it from evidence.
const facts: ResolveContext['values'] = {
  domain: 'eksempelbutik.dk',
  path: '/kassen',
  paths: '/produkter and /kassen',
  page: 'checkout',
  host: 'cdn-edge-7742.b-cdn-static.net',
  hosts: ['connect.facebook.net', 'www.google-analytics.com', 'static.hotjar.com'],
  essential_hosts: 'consent.cookiebot.com',
  tool: 'Microsoft Clarity',
  tool_host: 'www.clarity.ms',
  tracker: 'TikTok',
  font_families: 'Inter and Lora',
  font_hosts: 'fonts.googleapis.com and fonts.gstatic.com',
  form_path: '/kontakt',
  post_url_http: 'http://eksempelbutik.dk/kontakt/send',
  post_url_https: 'https://eksempelbutik.dk/kontakt/send',
  fields: 'navn, email, telefon and besked',
  control_id: 'news',
  label: 'Jeg accepterer handelsbetingelserne og vil gerne modtage nyhedsbrevet',
  recipients: 'The four using it · via Mette',
  owner: 'Mette',
  day: 'Tuesday',
};
const dk: ResolveContext = { jurisdiction: 'DK', locale: 'en', values: facts };

// A catalogue built for one test: the seed's entries plus whatever the rule needs.
function withEntries(...extra: Remedy[]): Catalogue {
  return new Catalogue([
    ...catalogue.all(),
    ...extra.map((remedy) => ({ remedy, file: `${remedy.id}.json`, hash: entryHash(remedy) })),
  ]);
}
const clone = (id: string): Remedy => structuredClone(catalogue.get(id)!.remedy);

describe('the honesty rules (R-04)', () => {
  it('a free self-service fix always outranks a paid one when both close the finding', () => {
    const ours = {
      ...clone('ai-03-move-to-gdprchat'),
      id: 'cns-02-ours',
      findingTypeId: 'CNS-02',
    } as Remedy;
    const r = resolveRemedy(withEntries(ours), 'CNS-02', dk);
    expect(r.ref.remedyId).toBe('cns-02-gate-tags');
    expect(r.cost).toBe('free');
    expect(r.ours).toBe(false);
    expect(r.candidates.find((c) => c.id === 'cns-02-ours')?.rejected).toMatch(
      /a paid remedy while cns-02-gate-tags closes CNS-02 for free/,
    );
  });

  it('anything of ours is flagged as ours in the returned object', () => {
    const r = resolveRemedy(catalogue, 'AI-03', dk);
    expect(r.ref.remedyId).toBe('ai-03-move-to-gdprchat');
    expect(r.ours).toBe(true);
    expect(r.cost).toBe('paid');
    expect(r.remedy.kind).toBe('our_product');
    if (r.remedy.kind === 'our_product') expect(r.remedy.product.id).toBe('gdprchat');
    expect(r.reason).toMatch(
      /ours, and no free fix or partner alternative closes AI-03; flagged as ours/,
    );

    expect(resolveRemedy(catalogue, 'CNS-02', dk).ours).toBe(false);
  });

  it('among paid remedies, someone else’s comes before ours', () => {
    const partner = {
      ...clone('trf-01-european-alternatives'),
      id: 'ai-03-partners',
      findingTypeId: 'AI-03',
    } as Remedy;
    const r = resolveRemedy(withEntries(partner), 'AI-03', dk);
    expect(r.ref.remedyId).toBe('ai-03-partners');
    expect(r.ours).toBe(false);
    expect(r.candidates.map((c) => c.id)).toEqual(['ai-03-partners', 'ai-03-move-to-gdprchat']);
    expect(r.candidates[1]?.rejected).toMatch(/outranked by ai-03-partners/);
  });

  it('a partner_alternative with fewer than two options is refused and degrades to no_solution', () => {
    expect(MIN_PARTNER_OPTIONS).toBe(2);
    const seed = clone('trf-01-european-alternatives');
    if (seed.kind !== 'partner_alternative') throw new Error('seed changed');
    const single = { ...seed, options: seed.options.slice(0, 1) } as Remedy;
    const only = new Catalogue([
      { remedy: single, file: 'x.json', hash: 'x' },
      catalogue.get(FALLBACK_REMEDY_ID)!,
    ]);
    const r = resolveRemedy(only, 'TRF-01', dk);
    expect(r.fallback).toBe(true);
    expect(r.closes).toBe(false);
    expect(r.ref.remedyId).toBe(FALLBACK_REMEDY_ID);
    expect(r.remedy.kind).toBe('no_solution');
    expect(r.reason).toMatch(/1 option\(s\) — fewer than 2 is not a choice/);

    const three = resolveRemedy(catalogue, 'TRF-01', dk);
    expect(three.ref.remedyId).toBe('trf-01-european-alternatives');
    expect(three.closes).toBe(true);
  });

  it('is deterministic and explained: the reason and every rejected candidate are on the result', () => {
    const a = resolveRemedy(catalogue, 'POL-09', dk);
    const b = resolveRemedy(catalogue, 'POL-09', dk);
    expect(a).toEqual(b);
    expect(a.ref.remedyId).toBe('pol-09-complaint-and-withdrawal-dk');
    expect(a.reason).toMatch(
      /^pol-09-complaint-and-withdrawal-dk: a free generated artefact that closes POL-09/,
    );
    expect(a.candidates).toEqual([
      expect.objectContaining({
        id: 'pol-09-complaint-and-withdrawal-dk',
        specific: true,
        cost: 'free',
      }),
      expect.objectContaining({
        id: 'pol-09-complaint-and-withdrawal',
        specific: false,
        rejected: 'outranked by pol-09-complaint-and-withdrawal-dk',
      }),
    ]);
    expect(resolveRemedy(catalogue, 'POL-09', { ...dk, jurisdiction: 'DE' }).ref.remedyId).toBe(
      'pol-09-complaint-and-withdrawal',
    );
  });
});

describe('templates are finished, or refused', () => {
  it('fills every placeholder from the case facts, lists one host per line', () => {
    const r = resolveRemedy(catalogue, 'CNS-02', dk);
    expect(r.remedy.kind).toBe('self_fix');
    if (r.remedy.kind !== 'self_fix' || r.remedy.action.kind !== 'agent_prompt') return;
    expect(r.remedy.action.body).toContain('On eksempelbutik.dk these third-party hosts');
    expect(r.remedy.action.body).toContain(
      '\n  connect.facebook.net\n  www.google-analytics.com\n  static.hotjar.com\n',
    );
    expect(r.remedy.action.body).toContain('consent.cookiebot.com must keep loading');
    expect(JSON.stringify(r.remedy)).not.toContain('{{');
    expect(RenderedRemedySchema.safeParse(r.remedy).success).toBe(true);
  });

  it('a template the case cannot fill is refused, naming the placeholder, rather than shipped half-done', () => {
    const { hosts: _hosts, ...withoutHosts } = facts;
    expect(_hosts).toBeDefined();
    const r = resolveRemedy(catalogue, 'CNS-02', { ...dk, values: withoutHosts });
    expect(r.fallback).toBe(true);
    expect(r.candidates[0]?.rejected).toBe('needs {{hosts}}, which the case does not supply');
    expect(r.reason).toMatch(/every candidate was refused: cns-02-gate-tags \(needs \{\{hosts\}\}/);
  });

  it('fill() reports what is missing and leaves it visible', () => {
    expect(fill('On {{domain}} at {{path}}', { domain: 'a.dk' })).toEqual({
      text: 'On a.dk at {{path}}',
      unfilled: ['path'],
    });
    expect(fill('{{hosts}}', { hosts: [] }).unfilled).toEqual(['hosts']);
  });
});

describe('locale and jurisdiction', () => {
  it('renders the requested locale and carries the translation gaps', () => {
    const r = resolveRemedy(catalogue, 'CNS-02', { ...dk, locale: 'da' });
    expect(r.locale).toBe('da');
    expect(r.remedy.title).toBe('Flyt dine tags om bag samtykket');
    expect(r.missingTranslations).toContain('detail');
    expect(resolveRemedy(catalogue, 'CNS-02', dk).missingTranslations).toEqual([]);
  });

  it('an unknown finding type or an unsupported jurisdiction falls back, explicitly', () => {
    const r = resolveRemedy(catalogue, 'XYZ-99', dk);
    expect(r.fallback).toBe(true);
    expect(r.candidates).toEqual([]);
    expect(r.reason).toBe(`${FALLBACK_REMEDY_ID}: no remedy in the catalogue for XYZ-99 in DK`);
    expect(r.remedy.kind).toBe('no_solution');
  });

  it('every fixture finding type resolves to a real remedy in every supported jurisdiction', () => {
    for (const typeId of fixtureTypes) {
      for (const jurisdiction of SUPPORTED_JURISDICTIONS) {
        const r = resolveRemedy(catalogue, typeId, { ...dk, jurisdiction });
        expect(r.fallback, `${typeId} in ${jurisdiction}: ${r.reason}`).toBe(typeId === 'VND-11');
        expect(RenderedRemedySchema.safeParse(r.remedy).success).toBe(true);
        expect(JSON.stringify(r.remedy)).not.toContain('{{');
      }
    }
  });

  it('the fallback entry is in the catalogue and is a no_solution', () => {
    const entry = catalogue.get(FALLBACK_REMEDY_ID);
    expect(entry?.remedy.kind).toBe('no_solution');
    expect(costOf('no_solution')).toBe('none');
    expect(() => resolveRemedy(new Catalogue([]), 'CNS-02', dk)).toThrow(
      /has no any-00-no-solution entry/,
    );
  });
});
