import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EvidenceSchema, PolicyDiscoverySchema } from '@gc/contracts';
import {
  BrowserPool,
  FixtureServer,
  discoverPolicies,
  loadFixtureSites,
  type FixtureHost,
} from '@gc/scanner';

// Ten synthetic sites standing in for the canary (the real one is T-10): the ways a
// policy is linked across languages, markup and site structure. Nine have one; the
// tenth has none and must be reported as a finding, not a failed scan.

const identity = {
  tenantId: 't-1',
  caseId: 'DK-26-0M4K',
  scanId: 'scan-1',
  capturedAt: '2026-09-03T09:14:00Z',
};
const root = mkdtempSync(join(tmpdir(), 'policies-'));

const page = (title: string, body: string, lang = 'da', head = '') =>
  `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`;
const policyText = (lang: string) =>
  `<h1>Privatlivspolitik</h1><p>${'Vi behandler personoplysninger om dig, når du handler hos os. '.repeat(8)}</p><p lang="${lang}">Du kan klage til Datatilsynet.</p>`;
const longText = (h: string) =>
  `<h1>${h}</h1><p>${'Denne side beskriver vores vilkår og hvordan vi arbejder. '.repeat(8)}</p>`;

function host(name: string, files: Record<string, string>): FixtureHost {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return { host: name, dir, routes: [] };
}

const hosts: FixtureHost[] = [
  host('pd1.test', {
    'index.html': page(
      'Butik',
      `<main>Velkommen</main><footer><a href="/privatlivspolitik.html">Privatlivspolitik</a> <a href="/cookiepolitik.html">Cookiepolitik</a> <a href="/handelsbetingelser.html">Handelsbetingelser</a></footer>`,
    ),
    'privatlivspolitik.html': page('Privatlivspolitik', policyText('da')),
    'cookiepolitik.html': page('Cookiepolitik', longText('Cookiepolitik')),
    'handelsbetingelser.html': page('Handelsbetingelser', longText('Handelsbetingelser')),
  }),
  host('pd2.test', {
    'index.html': page('Shop', `<footer><a href="/privacy/">Privacy Policy</a></footer>`, 'en'),
    'privacy/index.html': page('Privacy Policy', policyText('en'), 'en'),
  }),
  host('pd3.test', {
    'index.html': page(
      'Laden',
      `<footer><a href="/datenschutz">Datenschutzerklärung</a> <a href="/agb">AGB</a></footer>`,
      'de',
    ),
    'datenschutz/index.html': page('Datenschutzerklärung', policyText('de'), 'de'),
    'agb/index.html': page('AGB', longText('AGB'), 'de'),
  }),
  host('pd4.test', {
    'index.html': page(
      'Firma',
      `<footer><a rel="privacy-policy" href="/legal/p.html">Legal</a></footer>`,
    ),
    'legal/p.html': page('Legal', policyText('da')),
  }),
  host('pd5.test', {
    'index.html': page('Nothing links', `<main>Ingen links her.</main>`),
    'privacy-policy/index.html': page('Privacy policy', policyText('da')),
  }),
  host('pd6.test', {
    'index.html': page('Butik', `<footer><a href="/privatliv/">Privatliv</a></footer>`),
    'privatliv/index.html': page(
      'Privatlivspolitik',
      `${policyText('da')}<nav><a href="/privatliv/cookies.html">Cookies og privatliv</a> <a href="/privatliv/rettigheder.html">Dine rettigheder og persondata</a></nav>`,
    ),
    'privatliv/cookies.html': page('Cookies', longText('Cookies og privatliv')),
    'privatliv/rettigheder.html': page('Rettigheder', longText('Dine rettigheder')),
  }),
  host('pd7.test', {
    'index.html': page('Shop', `<footer><a href="/en/privacy">Privacy</a></footer>`, 'en'),
    'en/privacy/index.html': page(
      'Privacy',
      policyText('en'),
      'en',
      `<link rel="alternate" hreflang="da" href="/da/privatliv">`,
    ),
    'da/privatliv/index.html': page(
      'Privatliv',
      policyText('da'),
      'da',
      `<link rel="alternate" hreflang="en" href="/en/privacy">`,
    ),
  }),
  host('pd8.test', {
    'index.html': page(
      'Koncern',
      `<footer><a href="http://legal.pd8.test/privacy">Privacy</a></footer>`,
    ),
  }),
  host('legal.pd8.test', {
    'index.html': page('Legal', '<p>legal</p>'),
    'privacy/index.html': page('Privacy', policyText('en'), 'en'),
  }),
  host('pd9.test', {
    'index.html': page('Klinik', `<footer><a href="/persondata">Persondata</a></footer>`),
    'persondata/index.html': page('Persondata', policyText('da')),
  }),
  host('pd10.test', {
    'index.html': page('Ingen politik', `<footer><a href="/om">Om os</a></footer>`),
    'om/index.html': page('Om os', longText('Om os')),
  }),
];

const sites = loadFixtureSites();
let server: FixtureServer;
let pool: BrowserPool;

beforeAll(async () => {
  server = await new FixtureServer([...sites.flatMap((s) => s.hosts), ...hosts]).start();
  pool = await new BrowserPool({
    concurrency: 3,
    passTimeoutMs: 60_000,
    navigationTimeoutMs: 10_000,
    launch: { proxy: { server: server.proxy } },
    ignoreHTTPSErrors: true,
  }).start();
});

afterAll(async () => {
  await pool?.stop();
  await server?.stop();
});

describe('policy discovery (S-09)', () => {
  it('finds the privacy policy on at least 9 of 10 sites, and reports the tenth as a finding', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        discoverPolicies(pool, { url: `http://pd${i + 1}.test/` }, { identity }),
      ),
    );
    const found = results.filter((r) => r.discovery.observation.outcome === 'pass');
    expect(found.length).toBeGreaterThanOrEqual(9);
    for (const { discovery } of results)
      expect(PolicyDiscoverySchema.safeParse(discovery).success).toBe(true);

    const tenth = results[9]!.discovery;
    expect(tenth.observation).toMatchObject({ findingTypeId: 'POL-01', outcome: 'fail' });
    expect(tenth.missing).toEqual(['privacy', 'cookie', 'terms']);
    expect(tenth.observation.summary).toMatch(/No privacy policy could be found on pd10.test/);
  }, 180_000);

  it('records the URL, fetch time and content hash of every page as document evidence', async () => {
    const { discovery, evidence } = await discoverPolicies(
      pool,
      { url: 'http://pd1.test/' },
      { identity },
    );
    expect(discovery.documents.map((d) => d.kind).sort()).toEqual(['cookie', 'privacy', 'terms']);
    const privacy = discovery.documents.find((d) => d.kind === 'privacy')!.pages[0]!;
    expect(privacy).toMatchObject({
      finalUrl: 'http://pd1.test/privatlivspolitik.html',
      status: 200,
      language: 'da',
      foundBy: 'link',
    });
    expect(privacy.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const row = evidence.find((e) => e.id === privacy.evidence.evidenceId)!;
    expect(EvidenceSchema.safeParse(row).success).toBe(true);
    expect(row.kind).toBe('document');
    expect(row.hash).toBe(privacy.textHash);
    expect(row.body).toContain('Du kan klage til Datatilsynet.');
    expect(row.source.url).toBe('http://pd1.test/privatlivspolitik.html');
  });

  it('handles a multi-page policy and per-language variants', async () => {
    const multi = (await discoverPolicies(pool, { url: 'http://pd6.test/' }, { identity }))
      .discovery;
    const pages = multi.documents.find((d) => d.kind === 'privacy')!.pages;
    expect(pages.map((p) => p.finalUrl)).toEqual([
      'http://pd6.test/privatliv/',
      'http://pd6.test/privatliv/cookies.html',
      'http://pd6.test/privatliv/rettigheder.html',
    ]);
    expect(pages.slice(1).every((p) => p.foundBy === 'subpage')).toBe(true);

    const variants = (await discoverPolicies(pool, { url: 'http://pd7.test/' }, { identity }))
      .discovery;
    const vp = variants.documents.find((d) => d.kind === 'privacy')!.pages;
    expect(vp.map((p) => [p.language, p.foundBy])).toEqual([
      ['en', 'link'],
      ['da', 'alternate'],
    ]);
  });

  it('follows a rel hint, a well-known path, and a policy on a subdomain, and never leaves the site', async () => {
    const rel = (await discoverPolicies(pool, { url: 'http://pd4.test/' }, { identity })).discovery;
    expect(rel.documents.find((d) => d.kind === 'privacy')!.pages[0]!.foundBy).toBe('rel');
    const known = (await discoverPolicies(pool, { url: 'http://pd5.test/' }, { identity }))
      .discovery;
    expect(known.documents.find((d) => d.kind === 'privacy')!.pages[0]).toMatchObject({
      foundBy: 'well-known',
      finalUrl: 'http://pd5.test/privacy-policy',
    });
    const sub = (await discoverPolicies(pool, { url: 'http://pd8.test/' }, { identity })).discovery;
    expect(sub.documents.find((d) => d.kind === 'privacy')!.pages[0]!.finalUrl).toBe(
      'http://legal.pd8.test/privacy',
    );
    expect(server.refused.filter((r) => r.method === 'GET')).toEqual([]);
    expect(known.fetched).toBeLessThanOrEqual(12);
  });

  it('the committed fixtures: the shop and the brochure have a policy, the insecure shop has none', async () => {
    const shop = (await discoverPolicies(pool, { url: 'http://eksempelbutik.test/' }, { identity }))
      .discovery;
    expect(shop.documents.find((d) => d.kind === 'privacy')!.pages[0]!.finalUrl).toBe(
      'http://eksempelbutik.test/privatliv.html',
    );
    const brochure = (await discoverPolicies(pool, { url: 'https://brochure.test/' }, { identity }))
      .discovery;
    expect(brochure.observation.outcome).toBe('pass');
    const insecure = (await discoverPolicies(pool, { url: 'https://usikker.test/' }, { identity }))
      .discovery;
    expect(insecure.observation.outcome).toBe('fail');
  });
});
