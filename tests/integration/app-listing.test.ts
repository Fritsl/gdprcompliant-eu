import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createRecordedFetch, loadConfig, type FetchLike } from '@gc/config';
import { raiseFindings } from '@gc/findings';
import { loadCatalogue } from '@gc/remedies';
import {
  APP_DECLARATION_FINDING,
  checkAppListings,
  compareDeclared,
  loadAppCategories,
  storeLinks,
  type AppCheckInput,
} from '@gc/scanner';

// App listings (D-05): the site links to its app, the store listing declares what the
// app collects, and the privacy policy is held against it. A contradiction is a finding
// that quotes both sides; no app is a clean pass; a listing that cannot be read is
// undetermined, never an error. The stores are reached only through the recorded fetch.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const T0 = new Date('2026-09-04T09:30:00Z');
const NOW = () => T0;
const endpoints = JSON.parse(
  readFileSync(join(ROOT, 'packages', 'config', 'endpoints.json'), 'utf8'),
) as { host: string; purpose: string; jurisdiction: string }[];
const env = {
  NODE_ENV: 'test',
  APP_BASE_URL: 'https://gdprcompliant.eu',
  DATABASE_URL: 'postgres://gc:gc@localhost:5432/gc',
  MODEL_BASE_URL: 'https://llm.example.eu/v1',
  MODEL_API_KEY: 'sk-test',
  MODEL_CHAT: 'chat-model',
  MODEL_EMBEDDING: 'embed-model',
};
const configIn = (mode: 'record' | 'replay') =>
  loadConfig(
    { ...env, GC_NETWORK: mode },
    { endpoints: [...endpoints, { host: 'llm.example.eu', purpose: 'model', jurisdiction: 'DK' }] },
  );
const categories = loadAppCategories();
const catalogue = loadCatalogue();

const APPLE = 'https://apps.apple.com/dk/app/eksempelbutik/id1234567890';
const GOOGLE = 'https://play.google.com/store/apps/details?id=dk.eksempelbutik.app';
const APPLE_QUIET = 'https://apps.apple.com/dk/app/quiet/id1234567891';
const APPLE_BLANK = 'https://apps.apple.com/dk/app/blank/id1234567892';
const APPLE_GONE = 'https://apps.apple.com/dk/app/gone/id1234567893';

const applePage = (categoriesDeclared: string[]) =>
  `<html><head><title>Eksempelbutik on the App Store</title></head><body>
  <h1>Eksempelbutik</h1>
  <script id="shoebox-media-api-cache" type="fastboot/shoebox">{"privacyTypes":[{"privacyType":"Data Linked to You","dataCategories":[${categoriesDeclared.map((c) => `{"dataCategory":"${c}","dataTypes":["x"]}`).join(',')}]}]}</script>
  </body></html>`;
const googlePage = `<html><head><title>Eksempelbutik - Apps on Google Play</title></head><body>
  <h1>Eksempelbutik</h1><p>Shop from your phone. Location of our store: Testvej 1.</p>
  <h2>Data safety</h2><div>Safety starts with understanding how developers collect and share your data.</div>
  <h3>This app may collect these data types</h3>
  <div>Location</div><div>Personal info</div><div>Financial info</div>
  <h3>Data is encrypted in transit</h3>
  </body></html>`;

// The stores, stood in for: each answers in its documented page shape.
function standIn(): FetchLike {
  return vi.fn(async (url: string | URL) => {
    const u = String(url);
    const html = (body: string, status = 200) =>
      new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (u === APPLE) return html(applePage(['Location', 'Health & Fitness', 'Contact Info']));
    if (u === APPLE_QUIET) return html(applePage(['Contact Info', 'Purchases']));
    if (u === APPLE_BLANK)
      return html('<html><head><title>Blank</title></head><body>Nothing here</body></html>');
    if (u === APPLE_GONE) return html('gone', 404);
    if (u === GOOGLE) return html(googlePage);
    return html('not found', 404);
  });
}

const POLICY =
  'We collect your name, e-mail and address to deliver your order, and your payment details through our payment provider. We use cookies for statistics about how the site is used.';
const identity = {
  tenantId: 't-app',
  caseId: 'DK-26-APP1',
  scanId: 'scan-app',
  capturedAt: T0.toISOString(),
};
const policyEvidence = [{ evidenceId: 'document:policy0000000', hash: 'a'.repeat(64) }];
const input = (links: string[], over: Partial<AppCheckInput> = {}): AppCheckInput => ({
  links: links.map((href) => ({ href })),
  host: 'eksempelbutik.dk',
  identity,
  policyText: POLICY,
  policyUrl: 'https://eksempelbutik.dk/privatliv',
  policyEvidence,
  categories,
  now: NOW,
  ...over,
});

const cassettes = mkdtempSync(join(tmpdir(), 'app-stores-'));
afterAll(() => rmSync(cassettes, { recursive: true, force: true }));

describe('finding the app', () => {
  it('reads store links from the page and nothing else', () => {
    const links = storeLinks(
      [
        APPLE,
        `${APPLE}?l=da`,
        GOOGLE,
        'https://play.google.com/store/apps/developer?id=Eksempelbutik',
        'https://apps.apple.com/dk/developer/eksempelbutik/id99',
        'https://eksempelbutik.dk/app',
        'not a url',
      ].map((href) => ({ href })),
    );
    expect(links).toEqual([
      { store: 'apple', url: APPLE, appId: '1234567890' },
      { store: 'google', url: GOOGLE, appId: 'dk.eksempelbutik.app' },
    ]);
  });

  it('no link means no app: a clean pass with nothing read', async () => {
    const fetch = createRecordedFetch(configIn('replay'), {
      name: 'app-stores-none',
      dir: cassettes,
      impl: standIn(),
    });
    const check = await checkAppListings(
      input(['https://eksempelbutik.dk/', 'https://eksempelbutik.dk/privatliv']),
      fetch,
    );
    expect(check).toMatchObject({ outcome: 'pass', listings: [], drafts: [], evidence: [] });
    expect(check.summary).toBe('No app store listing is linked from eksempelbutik.dk.');
  });
});

describe('the store against the policy', () => {
  const upstream = standIn();
  const recorded = createRecordedFetch(configIn('record'), {
    name: 'app-stores-test',
    dir: cassettes,
    impl: upstream,
    now: NOW,
  });

  it('a declared category the policy never mentions is a finding quoting both sides', async () => {
    const check = await checkAppListings(input([APPLE, GOOGLE]), recorded);
    expect(check.outcome).toBe('fail');
    expect(check.listings.map((l) => [l.store, l.parsed, l.declared.map((d) => d.as)])).toEqual([
      ['apple', true, ['Contact Info', 'Health & Fitness', 'Location']],
      ['google', true, ['Personal info', 'Financial info', 'Location']],
    ]);
    expect(check.drafts).toHaveLength(2);
    const [apple, google] = check.drafts;
    expect(apple!.typeId).toBe(APP_DECLARATION_FINDING);
    expect(apple!.summary).toBe(
      'The App Store listing for Eksempelbutik on the App Store declares that the app collects "Health & Fitness" and "Location"; the privacy policy at https://eksempelbutik.dk/privatliv says nothing about health data, location.',
    );
    expect(google!.summary).toContain('declares that the app collects "Location"');
    // Both sides are on one evidence row, and the listing row is quoted at the categories.
    const both = check.evidence.find(
      (e) => e.kind === 'text' && e.body.includes('App Store listing'),
    );
    expect(both?.body).toContain('declares: Contact Info; Health & Fitness; Location');
    expect(both?.body).toContain(
      'Privacy policy (https://eksempelbutik.dk/privatliv) mentions: Contact Info',
    );
    expect(both?.body).toContain('does not mention: Health & Fitness; Location');
    const listingRow = check.evidence.find(
      (e) => e.kind === 'document' && e.body.includes('"store": "apple"'),
    );
    expect(apple!.evidence).toContainEqual({
      evidenceId: listingRow!.id,
      hash: listingRow!.hash,
      quote: 'Health & Fitness, Location',
    });
    expect(apple!.evidence).toContainEqual({ evidenceId: both!.id, hash: both!.hash });
    expect(apple!.evidence).toContainEqual(policyEvidence[0]);
    // The Play page mentions the shop's street location in prose; only the data safety section counts.
    const play = check.comparisons.find((c) => c.listing.store === 'google')!;
    expect(play.missing.map((d) => d.categoryId)).toEqual(['location']);
    expect(play.mentioned.map((d) => d.categoryId)).toEqual(['contact-info', 'financial']);
  });

  it('replays from the cassette with the network pulled, and never reaches the store', async () => {
    const pulled = vi.fn<FetchLike>(async () => {
      throw new Error('network pulled');
    });
    const replay = createRecordedFetch(configIn('replay'), {
      name: 'app-stores-test',
      dir: cassettes,
      impl: pulled,
      now: NOW,
    });
    const check = await checkAppListings(input([APPLE, GOOGLE]), replay);
    expect(check.outcome).toBe('fail');
    expect(check.drafts.map((d) => d.summary)).toEqual(
      (await checkAppListings(input([APPLE, GOOGLE]), recorded)).drafts.map((d) => d.summary),
    );
    expect(pulled).not.toHaveBeenCalled();
    expect(readdirSync(join(cassettes, 'app-stores-test')).length).toBeGreaterThanOrEqual(2);
    for (const f of readdirSync(join(cassettes, 'app-stores-test')))
      expect(readFileSync(join(cassettes, 'app-stores-test', f), 'utf8')).not.toMatch(
        /cookie|authorization/i,
      );
  });

  it('a listing the policy covers is a pass; one that cannot be read is undetermined, not an error', async () => {
    const covered = await checkAppListings(input([APPLE_QUIET]), recorded);
    expect(covered.outcome).toBe('pass');
    expect(covered.drafts).toEqual([]);
    expect(covered.summary).toContain('mentions everything the store declares');
    const blank = await checkAppListings(input([APPLE_BLANK]), recorded);
    expect(blank.outcome).toBe('undetermined');
    expect(blank.summary).toContain('could not be read');
    expect(blank.listings[0]!.parsed).toBe(false);
    const gone = await checkAppListings(input([APPLE_GONE]), recorded);
    expect(gone.outcome).toBe('undetermined');
    expect(gone.summary).toContain('HTTP 404');
    const noPolicy = await checkAppListings(
      input([APPLE], { policyText: undefined, policyUrl: undefined, policyEvidence: undefined }),
      recorded,
    );
    expect(noPolicy.outcome).toBe('undetermined');
    expect(noPolicy.summary).toContain('no privacy policy text');
  });

  it('the comparison reads the policy in any supported language', () => {
    const listing = {
      store: 'apple' as const,
      appId: '1',
      url: APPLE,
      declared: [
        { categoryId: 'location', as: 'Location' },
        { categoryId: 'health', as: 'Health & Fitness' },
      ],
      parsed: true,
      fetchedAt: T0.toISOString(),
    };
    const danish = compareDeclared(
      listing,
      'Vi behandler din placering for at vise nærmeste butik.',
      categories,
    );
    expect(danish.mentioned.map((d) => d.categoryId)).toEqual(['location']);
    expect(danish.missing.map((d) => d.categoryId)).toEqual(['health']);
    const german = compareDeclared(
      listing,
      'Wir verarbeiten Gesundheitsdaten und Ihren Standort.',
      categories,
    );
    expect(german.missing).toEqual([]);
  });

  it('the finding assembles with a remedy in every jurisdiction and cites the notice duty', async () => {
    const check = await checkAppListings(input([APPLE]), recorded);
    for (const jurisdiction of ['DK', 'DE'] as const) {
      const findings = raiseFindings(
        check.drafts.map((d) => ({ typeId: d.typeId, subject: d.subject, evidence: d.evidence })),
        { ...identity, jurisdiction, catalogue, scanId: 'scan-app', now: NOW },
      );
      expect(findings).toHaveLength(1);
      expect(JSON.stringify(findings[0]!.remedy)).toContain('app-01-say-what-the-app-collects');
      expect(findings[0]!.evidence.length).toBeGreaterThanOrEqual(3);
      expect(findings[0]!.binding.citations.map((c) => c.ref)).toEqual([
        'Art. 13(1)(c)',
        'Art. 5(1)(a)',
      ]);
    }
  });
});
