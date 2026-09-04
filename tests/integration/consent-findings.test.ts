import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONSENT_FINDINGS, type FindingTypeId } from '@gc/contracts';
import {
  BrowserPool,
  FixtureServer,
  collectPasses,
  diffPasses,
  loadFixtureSites,
  refTo,
} from '@gc/scanner';

// The consent findings end to end (S-05): three passes over each fixture, diffed. The
// site that ignores its banner raises CNS-02 naming its trackers; the late tracker
// raises CNS-01; the two-layer banners raise the path findings; the accept-only banner
// raises CNS-03; the forgetful one CNS-04; and every fixture that behaves raises no
// consent finding at all. Each fixture's must and mustNot lists are honoured.

const sites = loadFixtureSites();
const identity = {
  tenantId: 't-1',
  caseId: 'DK-26-0M4K',
  scanId: 'scan-1',
  capturedAt: '2026-09-04T09:14:00Z',
};
const quiet = { minDwellMs: 800, quietMs: 400, maxWaitMs: 8_000 };
let server: FixtureServer;
let pool: BrowserPool;

beforeAll(async () => {
  server = await new FixtureServer(sites.flatMap((s) => s.hosts)).start();
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

const CONSENT_TYPES = new Set<string>(Object.values(CONSENT_FINDINGS));

async function consentFindings(url: string, dwell = quiet) {
  const all = await collectPasses(pool, { url }, { identity, quiet: dwell });
  const result = diffPasses({
    a: all.a.capture,
    b: all.b.capture,
    c: all.c.capture,
    refusal: all.b.refusal,
    identity,
    refusalEvidence: all.b.evidence.map((e) => refTo(e)),
  });
  return { ...result, all };
}

describe('the consent findings, fixture by fixture', () => {
  it('reject-not-honoured: CNS-02 names the trackers that ignore the refusal', async () => {
    const { drafts, diff } = await consentFindings('http://eksempelbutik.test/');
    const cns02 = drafts.find((d) => d.typeId === 'CNS-02');
    expect(cns02, JSON.stringify(drafts)).toBeDefined();
    expect(cns02!.hosts).toEqual(['analytics.tracker.test', 'pixel.social.test']);
    expect(diff.hosts.find((h) => h.host === 'consent.cmp.test')?.role).toBe('consent-platform');
    expect(diff.refusal).toMatchObject({ made: true, remembered: true, interactions: 1 });
    expect(drafts.map((d) => d.typeId)).toEqual(['CNS-01', 'CNS-02']);
  });

  it('lazy-tracker: CNS-01 for the tag that arrives late, before anyone was asked', async () => {
    const { drafts, diff } = await consentFindings('http://lazyshop.test/', {
      minDwellMs: 5_500,
      quietMs: 600,
      maxWaitMs: 10_000,
    });
    expect(drafts.map((d) => d.typeId)).toEqual(['CNS-01']);
    expect(drafts[0]!.hosts).toEqual(['lazy.tracker.test']);
    const tracker = diff.hosts.find((h) => h.host === 'lazy.tracker.test')!;
    expect(tracker.role).toBe('tracking');
    expect(tracker.signals.join(' ')).toMatch(/reports to \/collect|sets cookie:_lz/);
  });

  it('banner-two-layer: no reject on the first layer, pre-ticked toggles, a buried refusal; no tracker findings', async () => {
    const { drafts } = await consentFindings('https://tolag.test/');
    expect(drafts.map((d) => d.typeId)).toEqual(['CNS-05', 'CNS-06', 'CNS-07']);
    for (const d of drafts) expect(d.evidence.length).toBeGreaterThan(1);
  });

  it('banner-accept-only: CNS-03; banner-forgets: CNS-04', async () => {
    const only = await consentFindings('https://kunja.test/');
    expect(only.drafts.map((d) => d.typeId)).toEqual(['CNS-03']);
    const forgets = await consentFindings('https://glemsom.test/');
    expect(forgets.drafts.map((d) => d.typeId)).toEqual(['CNS-04']);
  });

  it('the fixtures that behave raise no consent finding', async () => {
    for (const url of [
      'https://brochure.test/',
      'https://afvis.test/',
      'https://cybot.test/',
      'https://onetrust-shop.test/',
      'https://schatten.test/',
      'https://ramme.test/',
      'https://tilmeld.test/',
    ]) {
      const { drafts } = await consentFindings(url);
      expect(drafts, `${url}: ${JSON.stringify(drafts.map((d) => d.typeId))}`).toEqual([]);
    }
  });

  // At the scanner's own dwell, so a tag that arrives late is seen the way a visitor
  // would see it.
  const withConsentExpectations = sites.filter(
    (s) =>
      s.expected.findings.must.some((id) => CONSENT_TYPES.has(id)) ||
      s.expected.findings.mustNot.some((id) => CONSENT_TYPES.has(id)),
  );
  it.each(withConsentExpectations.map((s) => [s.name, s] as const))(
    'honours the must and mustNot of %s',
    async (_, site) => {
      const must = site.expected.findings.must.filter((id) => CONSENT_TYPES.has(id));
      const mustNot = site.expected.findings.mustNot.filter((id) => CONSENT_TYPES.has(id));
      const scheme = site.hosts.some((h) => h.routes.some((r) => r.scheme === 'http'))
        ? 'https'
        : 'http';
      const { drafts } = await consentFindings(`${scheme}://${site.expected.site}/`, {
        minDwellMs: 5_500,
        quietMs: 600,
        maxWaitMs: 10_000,
      });
      const raised = new Set<FindingTypeId>(drafts.map((d) => d.typeId));
      for (const id of must) expect(raised.has(id), `${site.name} must raise ${id}`).toBe(true);
      for (const id of mustNot)
        expect(raised.has(id), `${site.name} must not raise ${id}`).toBe(false);
    },
  );
});
