import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserPool, FixtureServer, loadFixtureSites, runChecks } from '@gc/scanner';

// The performance budget (T-11): the front door promises about a minute, and the suite
// holds the scanner to it against the whole fixture estate, at the 95th percentile.
// The deep pass over every site must finish inside ten minutes, and it hands over each
// site's result as it goes, so a caller can show partial results. The numbers are in
// budgets.json; a run over budget fails.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ARTIFACTS = join(ROOT, 'artifacts');
const budgets = JSON.parse(readFileSync(join(ROOT, 'tests', 'perf', 'budgets.json'), 'utf8')) as {
  threePassScan: { p95Ms: number };
  deepScan: { totalMs: number };
  reCheck: { fractionOfScan: number };
};

const sites = loadFixtureSites();
const identity = {
  tenantId: 't-perf',
  caseId: 'DK-26-PERF',
  scanId: 'perf',
  capturedAt: '2026-09-04T09:14:00Z',
};
let server: FixtureServer;
let pool: BrowserPool;

const p95 = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
};
const urlOf = (site: (typeof sites)[number]) =>
  `${site.hosts.some((h) => h.routes.some((r) => r.scheme === 'http')) ? 'https' : 'http'}://${site.expected.site}/`;

beforeAll(async () => {
  server = await new FixtureServer(sites.flatMap((s) => s.hosts)).start();
  pool = await new BrowserPool({
    concurrency: 3,
    passTimeoutMs: 60_000,
    navigationTimeoutMs: 15_000,
    launch: { proxy: { server: server.proxy } },
    ignoreHTTPSErrors: true,
  }).start();
  mkdirSync(ARTIFACTS, { recursive: true });
});

afterAll(async () => {
  await pool?.stop();
  await server?.stop();
});

describe('the scanner against the estate, on the clock', () => {
  it('a full scan of one site is under the front door budget at the 95th percentile, and the deep pass over every site hands each result over inside ten minutes', async () => {
    const started = Date.now();
    const perSite: { site: string; ms: number; findings: number }[] = [];
    const partials: number[] = [];
    for (const site of sites) {
      const t0 = Date.now();
      // The scanner's own dwell, so the numbers are the product's numbers.
      const out = await runChecks(pool, { url: urlOf(site) }, { identity });
      const ms = Date.now() - t0;
      perSite.push({
        site: site.name,
        ms,
        findings:
          (out.security?.filter((o) => o.outcome === 'fail').length ?? 0) +
          (out.forms?.filter((o) => o.outcome === 'fail').length ?? 0) +
          (out.replay?.filter((o) => o.outcome === 'fail').length ?? 0) +
          (out.consent?.length ?? 0),
      });
      // A partial result: what a caller could show before the estate is done.
      partials.push(Date.now() - started);
    }
    const total = Date.now() - started;
    const p95Ms = p95(perSite.map((s) => s.ms));
    const report = {
      at: new Date().toISOString(),
      sites: perSite,
      p95Ms,
      totalMs: total,
      budgets,
    };
    writeFileSync(join(ARTIFACTS, 'perf-scan.json'), JSON.stringify(report, null, 2));
    console.log(
      `perf: ${perSite.length} sites, p95 ${p95Ms} ms (budget ${budgets.threePassScan.p95Ms}), total ${total} ms (budget ${budgets.deepScan.totalMs})`,
    );
    expect(p95Ms).toBeLessThan(budgets.threePassScan.p95Ms);
    expect(total).toBeLessThan(budgets.deepScan.totalMs);
    // Partial results arrived before the end, one per site, in order.
    expect(partials.length).toBe(sites.length);
    expect(partials[0]!).toBeLessThan(total);
    for (let i = 1; i < partials.length; i += 1)
      expect(partials[i]!).toBeGreaterThanOrEqual(partials[i - 1]!);
  }, 660_000);

  it('a re-check of one family costs a fraction of the full scan of the same site', async () => {
    const url = 'https://usikker.test/';
    const full = await runChecks(pool, { url }, { identity });
    const one = await runChecks(pool, { url }, { identity, families: ['security'] });
    console.log(`perf: full ${full.durationMs} ms, one family ${one.durationMs} ms`);
    expect(one.durationMs).toBeLessThan(full.durationMs * budgets.reCheck.fractionOfScan);
  }, 120_000);
});
