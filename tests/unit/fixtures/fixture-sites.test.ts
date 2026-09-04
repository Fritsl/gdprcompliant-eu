import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURE_TAGS, FixtureExpectationSchema, FixtureRouteSchema } from '@gc/contracts';
import { FixtureError, externalReferences, loadFixtureSite, loadFixtureSites } from '@gc/scanner';

const sites = loadFixtureSites();

// Build a throwaway fixture directory for one test.
function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'fixture-'));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}
const expected = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ site: 'shop.test', description: 'x', findings: { must: ['CNS-02'] }, ...over });

describe('the fixture estate (F-07)', () => {
  it('every fixture loads, validates, and names a site among its hosts', () => {
    expect(sites.map((s) => s.name)).toEqual([
      'banner-accept-only',
      'banner-cookiebot-like',
      'banner-direct-reject',
      'banner-forgets',
      'banner-german-switches',
      'banner-in-iframe',
      'banner-onetrust-like',
      'banner-two-layer',
      'banner-usercentrics-shadow',
      'clean-brochure',
      'cloaked-shop',
      'huge-document',
      'injection-attempts',
      'insecure-forms',
      'lazy-tracker',
      'preticked-forms',
      'redirect-loop',
      'reject-not-honoured',
      'replay-unmasked',
      'slow-loris',
      'ssrf-attempts',
      'zip-bomb',
    ]);
    for (const s of sites) {
      expect(s.hosts.map((h) => h.host)).toContain(s.expected.site);
      expect(externalReferences(s)).toEqual([]);
    }
  });

  it('the reference fixture isolates the reject path, and the clean control asks for nothing', () => {
    const broken = sites.find((s) => s.name === 'reject-not-honoured')!;
    expect(broken.expected.findings.must).toEqual(['CNS-02']);
    expect(broken.expected.network.firstLoad.mustContact).toContain('analytics.tracker.test');
    expect(broken.expected.network.afterReject?.mustContact).toContain('analytics.tracker.test');
    expect(broken.hosts.find((h) => h.host === 'analytics.tracker.test')?.routes).toEqual([
      { path: '/collect', status: 204, headers: { 'cache-control': 'no-store' } },
    ]);

    const clean = sites.find((s) => s.name === 'clean-brochure')!;
    expect(clean.expected.tags).toEqual(['clean']);
    expect(clean.expected.findings.must).toEqual([]);
    expect(clean.expected.findings.mustNot.length).toBeGreaterThan(0);
    expect(clean.hosts).toHaveLength(1);
  });

  it('fixtures are plain files: no build step, no package manager', () => {
    for (const s of sites) {
      for (const h of s.hosts) {
        expect(externalReferences({ dir: s.dir, hosts: [h] }).map((e) => e.host)).toEqual(
          expect.not.arrayContaining(['unpkg.com', 'cdn.jsdelivr.net']),
        );
      }
      expect(() => loadFixtureSite(s.dir)).not.toThrow();
    }
  });
});

describe('expected.json is validated by its schema', () => {
  it('accepts the documented shape and fills defaults', () => {
    const parsed = FixtureExpectationSchema.parse({
      site: 'shop.test',
      description: 'Rejecting cookies leaves the trackers running.',
      findings: { must: ['CNS-02'] },
    });
    expect(parsed.findings.mustNot).toEqual([]);
    expect(parsed.network.firstLoad).toEqual({ mustContact: [], mustNotContact: [] });
    expect(parsed.tags).toEqual([]);
  });

  it('a finding cannot be both required and forbidden', () => {
    expect(
      FixtureExpectationSchema.safeParse({
        site: 'shop.test',
        description: 'x',
        findings: { must: ['CNS-02'], mustNot: ['CNS-02'] },
      }).success,
    ).toBe(false);
  });

  it('finding ids are stable identities, never articles; tags are a closed vocabulary', () => {
    expect(
      FixtureExpectationSchema.safeParse({ site: 'shop.test', description: 'x', findings: { must: ['Art. 5(3)'] } })
        .success,
    ).toBe(false);
    expect(FixtureExpectationSchema.safeParse({ site: 'shop.test', description: 'x', tags: ['weird'] }).success).toBe(
      false,
    );
    expect(FIXTURE_TAGS).toContain('shadow-dom');
    expect(FixtureRouteSchema.parse({ path: '/x' })).toEqual({ path: '/x', status: 200, headers: {} });
    expect(FixtureRouteSchema.safeParse({ path: 'x' }).success).toBe(false);
  });
});

describe('loading refuses what cannot be trusted as ground truth', () => {
  it('a fixture without expected.json, or with an invalid one, is refused by name', () => {
    expect(() => loadFixtureSite(fixture({ 'hosts/shop.test/index.html': '<p>x</p>' }), 'nameless')).toThrow(
      /fixture nameless: has no expected.json/,
    );
    expect(() =>
      loadFixtureSite(fixture({ 'expected.json': '{ nope', 'hosts/shop.test/index.html': '' }), 'broken'),
    ).toThrow(/broken: expected.json is not valid JSON/);
    expect(() =>
      loadFixtureSite(fixture({ 'expected.json': expected({ site: 'other.test' }), 'hosts/shop.test/index.html': '' }), 'x'),
    ).toThrow(/site other.test is not one of its hosts/);
  });

  it('a host without an index.html, or a network expectation naming a stranger, is refused', () => {
    expect(() =>
      loadFixtureSite(fixture({ 'expected.json': expected(), 'hosts/shop.test/style.css': '' }), 'x'),
    ).toThrow(/host shop.test has no index.html/);
    expect(() =>
      loadFixtureSite(
        fixture({
          'expected.json': expected({ network: { firstLoad: { mustContact: ['tracker.test'] } } }),
          'hosts/shop.test/index.html': '',
        }),
        'x',
      ),
    ).toThrow(/network.firstLoad names tracker.test, which is not a fixture host/);
  });

  it('a fixture that references the real internet is refused before anything runs', () => {
    const dir = fixture({
      'expected.json': expected(),
      'hosts/shop.test/index.html': '<script src="https://www.googletagmanager.com/gtm.js"></script>',
    });
    let error: unknown;
    try {
      loadFixtureSite(dir, 'leaky');
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(FixtureError);
    expect((error as Error).message).toMatch(
      /fixture leaky: references the real internet: hosts\/shop.test\/index.html → www.googletagmanager.com/,
    );
  });

  it('references to the fixture’s own hosts, protocol-relative included, are fine', () => {
    const dir = fixture({
      'expected.json': expected(),
      'hosts/shop.test/index.html': '<script src="//cdn.shop.test/a.js"></script><a href="http://shop.test/x">x</a>',
      'hosts/cdn.shop.test/index.html': '',
    });
    expect(loadFixtureSite(dir, 'ok').hosts.map((h) => h.host)).toEqual(['cdn.shop.test', 'shop.test']);
  });
});
