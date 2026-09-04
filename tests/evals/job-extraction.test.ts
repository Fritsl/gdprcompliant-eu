import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { VendorSchema } from '@gc/contracts';
import {
  advertCandidates,
  careersLinks,
  extractTools,
  loadToolMap,
  type AdvertPage,
} from '@gc/scanner';

// Job advert stack extraction (D-04), measured: over a fixed set of public adverts in
// three languages, a tool is claimed only when named as written, so the extractor makes
// no false claim at all and misses little; an advert behind a login or gone is never
// read; and every candidate carries the advert it came from, with its address and
// date, as evidence.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
interface Advert {
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly postedAt?: string;
  readonly status?: number;
  readonly requiresLogin?: boolean;
  readonly expected: string[];
}
const set = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'adverts', 'set.json'), 'utf8')) as {
  domain: string;
  adverts: Advert[];
};
const tools = loadToolMap();
const T0 = new Date('2026-09-04T10:00:00Z');
const identity = {
  tenantId: 't-adverts',
  caseId: 'DK-26-ADV1',
  scanId: 'scan-adverts',
  capturedAt: T0.toISOString(),
};
const page = (a: Advert): AdvertPage => ({
  url: a.url,
  title: a.title,
  text: a.text,
  ...(a.postedAt ? { postedAt: a.postedAt } : {}),
  fetchedAt: T0.toISOString(),
  status: a.status ?? 200,
  requiresLogin: a.requiresLogin ?? false,
});

describe('the tool map', () => {
  it('names every tool as the adverts write it, and guards the ordinary words', () => {
    expect(tools.tools.length).toBeGreaterThanOrEqual(20);
    for (const t of tools.tools) {
      expect(t.names.length, t.id).toBeGreaterThan(0);
      expect(t.vendorId !== undefined || t.country !== undefined, `${t.id} says who runs it`).toBe(
        true,
      );
    }
    for (const word of ['Slack', 'Notion', 'Stripe', 'Dinero'])
      expect(
        tools.tools.find((t) => t.names.includes(word) || t.names.includes(`Microsoft ${word}`))
          ?.caseSensitive ?? true,
        word,
      ).toBe(true);
  });
});

describe('extraction is conservative', () => {
  const readable = set.adverts.filter((a) => !a.requiresLogin && (a.status ?? 200) === 200);

  it('makes no false claim on any advert, and misses little across the set', () => {
    let expected = 0;
    let found = 0;
    for (const a of readable) {
      const got = extractTools(a.text, tools.tools).map((m) => m.toolId);
      const wrong = got.filter((id) => !a.expected.includes(id));
      expect(wrong, `${a.url} claims ${wrong.join(', ')}`).toEqual([]);
      expected += a.expected.length;
      found += got.filter((id) => a.expected.includes(id)).length;
    }
    expect(expected).toBeGreaterThanOrEqual(20);
    expect(found / expected).toBeGreaterThanOrEqual(0.95);
  });

  it('a skill, a job title or an ordinary word is not a tool', () => {
    const analyst = readable.find((a) => a.url.endsWith('/data-analyst'))!;
    expect(extractTools(analyst.text, tools.tools)).toEqual([]);
    const warehouse = readable.find((a) => a.url.endsWith('/teamleder-lager'))!;
    expect(extractTools(warehouse.text, tools.tools)).toEqual([]);
    expect(extractTools('We use slack and notion.', tools.tools)).toEqual([]);
    expect(extractTools('We use Slack and Notion.', tools.tools).map((m) => m.toolId)).toEqual([
      'slack',
      'notion',
    ]);
    expect(extractTools('Salesforcex is not Salesforce.', tools.tools).map((m) => m.name)).toEqual([
      'Salesforce',
    ]);
  });

  it('every mention quotes the words around the name, as written', () => {
    for (const a of readable)
      for (const m of extractTools(a.text, tools.tools)) {
        expect(a.text).toContain(m.name);
        expect(m.quote).toContain(m.name);
        expect(m.quote.length).toBeLessThanOrEqual(260);
      }
  });
});

describe('candidates carry the advert as evidence', () => {
  const result = advertCandidates(set.adverts.map(page), identity, { domain: set.domain, tools });

  it('reads only public listings: the login-walled and the gone advert are skipped, by reason', () => {
    expect(result.skipped).toEqual([
      { url: 'https://eksempelbutik.dk/jobs/intern-portal', reason: 'behind a login' },
      { url: 'https://eksempelbutik.dk/jobs/gone', reason: 'HTTP 404' },
    ]);
    expect(result.candidates.map((c) => c.id)).not.toContain(`vendor:advert:workday:${set.domain}`);
    expect(result.mentions.map((m) => m.url)).not.toContain(
      'https://eksempelbutik.dk/jobs/intern-portal',
    );
  });

  it('one candidate per tool, resting on every advert that names it, with address and date', () => {
    const ids = result.candidates.map((c) => c.id).sort();
    const expectedTools = [
      ...new Set(
        set.adverts
          .filter((a) => !a.requiresLogin && (a.status ?? 200) === 200)
          .flatMap((a) => a.expected),
      ),
    ].sort();
    expect(ids).toEqual(expectedTools.map((t) => `vendor:advert:${t}:${set.domain}`));
    for (const c of result.candidates) {
      expect(VendorSchema.safeParse(c).success).toBe(true);
      expect(c.provenance.source).toBe('observation');
      expect(c.provenance.evidence.length).toBeGreaterThan(0);
      for (const ref of c.provenance.evidence) {
        const row = result.evidence.find((e) => e.id === ref.evidenceId)!;
        expect(row).toBeDefined();
        expect(row.hash).toBe(ref.hash);
        const body = JSON.parse(row.body) as { url: string; postedAt?: string; fetchedAt: string };
        expect(body.url).toMatch(/^https:\/\/eksempelbutik\.dk\/(jobs|karriere)\//);
        expect(row.source.url).toBe(body.url);
        expect(row.caption).toContain('Job advert at');
        expect(body.postedAt ?? body.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}/);
        expect(ref.quote).toBeTruthy();
      }
    }
    // Microsoft 365 is named in three adverts; the candidate rests on all three and is
    // seen from the earliest.
    const m365 = result.candidates.find(
      (c) => c.id === `vendor:advert:microsoft-365:${set.domain}`,
    )!;
    expect(m365.provenance.evidence).toHaveLength(3);
    expect(m365.provenance.seenAt).toBe('2026-08-25T00:00:00.000Z');
    expect(m365.resolution).toBe('resolved');
    expect(m365.legalEntity?.name).toBeTruthy();
    // A tool without a registry entry stays unresolved, with where it contracts from.
    const salesforce = result.candidates.find(
      (c) => c.id === `vendor:advert:salesforce:${set.domain}`,
    )!;
    expect(salesforce.resolution).toBe('unresolved');
    expect(salesforce.jurisdiction).toBe('US');
    expect(salesforce.provenance.registryVersion).toBe(`advert-tools@${tools.version}`);
  });

  it('is deterministic', () => {
    const again = advertCandidates(set.adverts.map(page), identity, { domain: set.domain, tools });
    expect(again).toEqual(result);
  });
});

describe('finding the careers page', () => {
  it('follows the site’s own careers link in any of our languages, and nothing off-site', () => {
    const links = [
      { href: 'https://eksempelbutik.dk/om-os', text: 'Om os', inFooter: true },
      {
        href: 'https://eksempelbutik.dk/ledige-stillinger',
        text: 'Ledige stillinger',
        inFooter: true,
      },
      { href: 'https://eksempelbutik.dk/karriere', text: 'Karriere', inFooter: false },
      { href: 'https://www.linkedin.com/company/eksempelbutik/jobs', text: 'Jobs', inFooter: true },
      { href: 'https://jobs.eksempelbutik.dk/', text: 'Join us', inFooter: false },
    ];
    expect(careersLinks(links, 'eksempelbutik.dk')).toEqual([
      'https://eksempelbutik.dk/ledige-stillinger',
      'https://eksempelbutik.dk/karriere',
      'https://jobs.eksempelbutik.dk/',
    ]);
  });
});
