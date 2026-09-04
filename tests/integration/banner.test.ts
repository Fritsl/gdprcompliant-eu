import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConsentRefusalSchema, EvidenceSchema, NO_REFUSAL_PATH_FINDING } from '@gc/contracts';
import { BrowserPool, FixtureServer, loadFixtureSites, refuseConsent } from '@gc/scanner';

// Consent banners (S-03): against the banner fixtures, the scanner finds the banner,
// names the platform where a signature gives it away, and clicks through to a refusal
// that closes it: a direct "no", or settings, toggles off, save; in the page, in a
// shadow root, in a frame. Every step has a screenshot. A banner with no refusal is
// reported as undetermined and raises the finding; a page with no banner says so.

const sites = loadFixtureSites();
const bannerSites = sites.filter((s) => s.expected.consent !== undefined);
const identity = {
  tenantId: 't-1',
  caseId: 'DK-26-0M4K',
  scanId: 'scan-1',
  capturedAt: '2026-09-04T09:14:00Z',
};
let server: FixtureServer;
let pool: BrowserPool;

beforeAll(async () => {
  server = await new FixtureServer(sites.flatMap((s) => s.hosts)).start();
  pool = await new BrowserPool({
    concurrency: 2,
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

describe('refusing consent on every banner fixture', () => {
  it('has at least eight banner fixtures covering different patterns', () => {
    expect(bannerSites.length).toBeGreaterThanOrEqual(8);
    const platforms = new Set(bannerSites.map((s) => s.expected.consent!.platform));
    expect(platforms.size).toBeGreaterThanOrEqual(4);
    expect(bannerSites.some((s) => s.expected.tags.includes('shadow-dom'))).toBe(true);
    expect(bannerSites.some((s) => s.expected.tags.includes('iframe'))).toBe(true);
    expect(bannerSites.some((s) => s.expected.consent!.outcome === 'undetermined')).toBe(true);
  });

  it.each(bannerSites.map((s) => [s.name, s] as const))('%s', async (_, site) => {
    const expected = site.expected.consent!;
    const { refusal, evidence } = await refuseConsent(
      pool,
      { url: `https://${site.expected.site}/` },
      { identity, now: () => new Date('2026-09-04T09:14:00Z') },
    );
    expect(ConsentRefusalSchema.safeParse(refusal).success).toBe(true);
    expect(refusal.bannerFound, refusal.summary).toBe(true);
    expect(refusal.platform, refusal.summary).toBe(expected.platform);
    expect(refusal.outcome, refusal.summary).toBe(expected.outcome);
    if (expected.minSteps) expect(refusal.steps.length).toBeGreaterThanOrEqual(expected.minSteps);
    if (expected.maxSteps) expect(refusal.steps.length).toBeLessThanOrEqual(expected.maxSteps);

    // A screenshot per step, each a stored, hashed evidence row the step points at.
    expect(refusal.steps.map((s) => s.n)).toEqual(refusal.steps.map((_, i) => i + 1));
    for (const step of refusal.steps) {
      const row = evidence.find((e) => e.id === step.screenshot.evidenceId);
      expect(row, step.target).toBeDefined();
      expect(row!.kind).toBe('screenshot');
      expect(row!.hash).toBe(step.screenshot.hash);
      expect(EvidenceSchema.safeParse(row).success).toBe(true);
      expect(Buffer.from(row!.body, 'base64').subarray(1, 4).toString()).toBe('PNG');
    }
    expect(refusal.steps[0]!.action).toBe('found');

    if (expected.outcome === 'refused') {
      expect(refusal.bannerHiddenAfter).toBe(true);
      expect(refusal.steps.at(-1)!.action).toBe('hidden');
      expect(refusal.finding).toBeUndefined();
    } else {
      expect(refusal.finding?.findingTypeId).toBe(NO_REFUSAL_PATH_FINDING);
      expect(refusal.finding?.evidence.length).toBeGreaterThan(0);
      expect(refusal.summary).toMatch(/no refusal/);
    }
  });

  it('the two-layer banners are refused by opening settings, switching every optional toggle off and saving', async () => {
    for (const host of ['tolag.test', 'schalter.test']) {
      const { refusal } = await refuseConsent(pool, { url: `https://${host}/` }, { identity });
      expect(refusal.outcome, refusal.summary).toBe('refused');
      const actions = refusal.steps.map((s) => s.action);
      expect(actions.filter((a) => a === 'toggle_off').length).toBeGreaterThanOrEqual(2);
      expect(actions).toContain('save');
      expect(refusal.summary).toMatch(/switched \d+ toggle\(s\) off and saved/);
    }
  });

  it('the frame and the shadow root are looked into, and the step says which frame', async () => {
    const framed = await refuseConsent(pool, { url: 'https://ramme.test/' }, { identity });
    expect(framed.refusal.outcome, framed.refusal.summary).toBe('refused');
    expect(framed.refusal.recognisedBy).toBe('heuristic');
    expect(framed.refusal.steps.some((s) => s.frame?.includes('consent-frame'))).toBe(true);
    const shadow = await refuseConsent(pool, { url: 'https://schatten.test/' }, { identity });
    expect(shadow.refusal.platform).toBe('usercentrics');
    expect(shadow.refusal.recognisedBy).toBe('signature');
    expect(shadow.refusal.outcome, shadow.refusal.summary).toBe('refused');
  });

  it('a page without a banner is no_banner, not a refusal', async () => {
    const { refusal, evidence } = await refuseConsent(
      pool,
      { url: 'https://brochure.test/' },
      { identity },
    );
    expect(refusal).toMatchObject({
      bannerFound: false,
      outcome: 'no_banner',
      bannerHiddenAfter: true,
    });
    expect(refusal.platform).toBeUndefined();
    expect(evidence).toHaveLength(1);
  });
});
