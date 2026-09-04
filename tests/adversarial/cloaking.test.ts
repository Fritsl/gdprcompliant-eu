import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scannerUserAgent } from '@gc/config';
import { assembleFindings } from '@gc/findings';
import { loadCatalogue } from '@gc/remedies';
import {
  BrowserPool,
  FixtureServer,
  collectPassA,
  loadFixtureSites,
  runSecurityChecks,
} from '@gc/scanner';

// Cloaking (T-06): a site that shows a clean page to anything calling itself a scanner
// and the trackers to everyone else. It must be detected, and reported as its own
// finding with a remedy, not congratulated for the clean page.

const sites = loadFixtureSites();
const identity = {
  tenantId: 't-adv',
  caseId: 'DK-26-CLOK',
  scanId: 'adv-cloak',
  capturedAt: '2026-09-04T09:14:00Z',
};
const quiet = { minDwellMs: 500, quietMs: 300, maxWaitMs: 6_000 };
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
    resolveEgress: false,
  }).start();
});

afterAll(async () => {
  await pool?.stop();
  await server?.stop();
});

describe('a site that cloaks', () => {
  it('is caught: the browser gets a tracker the declared scanner never sees, and that is the finding', async () => {
    const target = { url: 'https://cloaked.shop.test/' };
    const { capture } = await collectPassA(pool, target, { quiet });
    expect(capture.requests.map((r) => r.host)).toContain('sporing.tracker.test');
    const surface = await runSecurityChecks(pool, target, { capture, identity });
    const cloak = surface.observations.find((o) => o.check === 'cloaking')!;
    expect(cloak).toBeDefined();
    expect(cloak.outcome).toBe('fail');
    expect(cloak.findingTypeId).toBe('CLK-01');
    expect(cloak.detail['onlyForBrowsers']).toEqual(['sporing.tracker.test']);
    expect(cloak.detail['declaredHosts']).toEqual([]);
    expect(cloak.summary).toMatch(/withholds from a request declared as GDPRcompliant-scanner/);
    // The evidence is the two host lists, kept as a diff, and the observation points at it.
    const ev = surface.evidence.find((e) => e.id === cloak.evidence[0]!.evidenceId)!;
    expect(ev.kind).toBe('pass_diff');
    expect(JSON.parse(ev.body)).toMatchObject({
      declaredUserAgent: scannerUserAgent(),
      onlyForBrowsers: ['sporing.tracker.test'],
    });
    // And it becomes a finding a person can act on, with a remedy in every jurisdiction.
    const catalogue = loadCatalogue();
    for (const jurisdiction of ['DK', 'DE'] as const) {
      const assembled = assembleFindings(
        { security: surface.observations },
        {
          ...identity,
          jurisdiction,
          catalogue,
          host: 'cloaked.shop.test',
          now: () => new Date(identity.capturedAt),
        },
      );
      const finding = assembled.findings.find((f) => f.typeId === 'CLK-01')!;
      expect(finding, jurisdiction).toBeDefined();
      expect(finding.remedy.remedyId).toBe('clk-01-same-site-for-everyone');
      expect(finding.binding.citations.length).toBeGreaterThan(0);
    }
  }, 90_000);

  it('a site that serves everyone the same page passes the same check', async () => {
    const target = { url: 'https://brochure.test/' };
    const { capture } = await collectPassA(pool, target, { quiet });
    const surface = await runSecurityChecks(pool, target, { capture, identity });
    const cloak = surface.observations.find((o) => o.check === 'cloaking')!;
    expect(cloak.outcome).toBe('pass');
    expect(cloak.detail['onlyForBrowsers']).toEqual([]);
  }, 90_000);
});
