import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  caseByToken,
  createTestDatabase,
  referralOf,
  seedRemedies,
  testDatabaseUrl,
  type TestDatabase,
} from '@gc/db';
import { JobQueue } from '@gc/jobs';
import { loadCatalogue } from '@gc/remedies';
import { BrowserPool, FixtureServer, loadFixtureSites, type FixtureHost } from '@gc/scanner';
import { registerRecheckWorker, registerScanWorker } from '@gc/worker';

// Referral and benchmarks (L-04), in a real browser: the ask appears the moment a fix is
// confirmed and nowhere else; the link carries a first-party code and nothing else, a
// scan started from it is attributed on our side without a tracker or a cookie; and
// the benchmark comes from the canary corpus and says how many sites it rests on.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WEB = join(ROOT, 'apps', 'web');
const ARTIFACTS = join(ROOT, 'artifacts');
const PORT = 3433;
const BASE = `http://127.0.0.1:${PORT}`;
// The same server under its other name: the scan route redirects by host header.
const OURS = [BASE, `http://localhost:${PORT}`];
const elsewhere = (urls: string[]) => urls.filter((u) => !OURS.some((o) => u.startsWith(o)));
const next = join(WEB, 'node_modules', 'next', 'dist', 'bin', 'next');
const url = testDatabaseUrl();

async function waitFor(target: string, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const r = await fetch(target, { redirect: 'manual' });
      if (r.status < 500) return;
      last = `HTTP ${r.status}`;
    } catch (e) {
      last = (e as Error).message;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${target} did not come up: ${last}`);
}

// A benchmark file as the nightly canary writes it: how many open findings each of the
// watched sites had. Forty sites, most with more than the fixture will have.
const benchmarkDir = mkdtempSync(join(tmpdir(), 'benchmark-'));
const BENCHMARK = join(benchmarkDir, 'benchmark.json');
writeFileSync(
  BENCHMARK,
  JSON.stringify({
    date: '2026-09-03',
    n: 40,
    counts: [
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25,
      26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39,
    ],
  }),
);

describe.skipIf(!url)('referral and benchmarks (L-04)', () => {
  let t: TestDatabase;
  let server: ChildProcess | undefined;
  let browser: Browser;
  let fixtures: FixtureServer;
  let pool: BrowserPool;
  let queue: JobQueue;
  const liveHeaders: Record<string, string> = {};
  let token = '';
  let code = '';

  beforeAll(async () => {
    t = await createTestDatabase(url);
    const catalogue = loadCatalogue();
    await seedRemedies(t, catalogue);
    const hosts = loadFixtureSites()
      .flatMap((s) => s.hosts)
      .map((h): FixtureHost => (h.host === 'usikker.test' ? { ...h, headers: liveHeaders } : h));
    fixtures = await new FixtureServer(hosts).start();
    pool = await new BrowserPool({
      concurrency: 2,
      passTimeoutMs: 60_000,
      navigationTimeoutMs: 10_000,
      launch: { proxy: { server: fixtures.proxy } },
      ignoreHTTPSErrors: true,
    }).start();
    queue = new JobQueue({ connectionString: url, pollingIntervalSeconds: 1 });
    await queue.start();
    const quiet = { minDwellMs: 800, quietMs: 400, maxWaitMs: 8_000 };
    await registerScanWorker(queue, t, { pool, catalogue, quiet });
    await registerRecheckWorker(queue, t, { pool, catalogue, quiet });
    mkdirSync(ARTIFACTS, { recursive: true });
    if (!existsSync(join(WEB, '.next', 'BUILD_ID')) || process.env['GC_E2E_BUILD'] === '1') {
      const build = spawnSync(process.execPath, [next, 'build', '--webpack'], {
        cwd: WEB,
        stdio: 'pipe',
        encoding: 'utf8',
      });
      if (build.status !== 0)
        throw new Error(`next build failed:\n${build.stdout}\n${build.stderr}`);
    }
    server = spawn(process.execPath, [next, 'start', '-p', String(PORT), '-H', '127.0.0.1'], {
      cwd: WEB,
      stdio: 'pipe',
      env: {
        ...process.env,
        DATABASE_URL: url,
        GC_SEARCH_PATH: `${t.schema},public`,
        APP_BASE_URL: BASE,
        CANARY_BENCHMARK_FILE: BENCHMARK,
      },
    });
    await waitFor(`${BASE}/en`, 60_000);
    browser = await chromium.launch();
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    server?.kill();
    await queue?.stop({ graceful: false });
    await pool?.stop();
    await fixtures?.stop();
    await t?.drop();
    rmSync(benchmarkDir, { recursive: true, force: true });
  });

  it('the ask appears the moment a fix is confirmed, and nowhere before', async () => {
    const page = await browser.newPage();
    await page.goto(`${BASE}/en`);
    await page.fill('input[name="domain"]', 'usikker.test');
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/en\/scan\/[^/]+$/, { timeout: 20_000 });
    await page.locator('.scan-steps[data-done]').waitFor({ timeout: 120_000 });
    await page.locator('.scan-out a.btn').click();
    await page.waitForURL(/\/en\/c\/[a-f0-9]{64}$/, { timeout: 20_000 });
    token = page.url().split('/').pop()!;
    const found = await caseByToken(t, token);
    code = (await referralOf(t, found!.tenantId, found!.caseId)).code;
    expect(code).toMatch(/^[a-f0-9]{12}$/);

    // Nothing asks yet: not the case page, not the register, not the questions, not the timeline.
    for (const path of ['', '/register', '/questions', '/timeline']) {
      await page.goto(`${BASE}/en/c/${token}${path}`);
      expect(await page.locator('[data-referral]').count(), path).toBe(0);
    }
    await page.goto(`${BASE}/en`);
    expect(await page.locator('[data-referral]').count()).toBe(0);

    // Fix, re-check, and the ask arrives with the confirmation, with the code in the link.
    await page.goto(`${BASE}/en/c/${token}`);
    liveHeaders['strict-transport-security'] = 'max-age=63072000; includeSubDomains';
    await page.locator('li.step[data-type="SEC-03"] form.step-act button').click();
    await page.waitForURL(/recheck=/);
    const report = page.locator('li.step[data-type="SEC-03"] [role=status]');
    await expect
      .poll(() => report.getAttribute('data-recheck'), { timeout: 120_000 })
      .toBe('closed');
    const ask = report.locator('[data-referral]');
    expect(await ask.count()).toBe(1);
    const link = await ask.locator('a').getAttribute('href');
    expect(link).toBe(`${BASE}/en?ref=${code}`);
    // One ask, in one place.
    expect(await page.locator('[data-referral]').count()).toBe(1);
    await page.close();
  }, 300_000);

  it('a scan started from the link is attributed here, with no tracker and no cookie', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const requests: string[] = [];
    page.on('request', (r) => requests.push(r.url()));
    await page.goto(`${BASE}/en?ref=${code}`);
    expect(await page.locator('input[name="ref"]').getAttribute('value')).toBe(code);
    expect(elsewhere(requests)).toEqual([]);
    expect(await context.cookies()).toEqual([]);
    await page.fill('input[name="domain"]', 'tilmeld.test');
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/en\/scan\/[^/]+$/, { timeout: 20_000 });
    await page.locator('.scan-steps[data-done]').waitFor({ timeout: 120_000 });
    await page.locator('.scan-out a.btn').click();
    await page.waitForURL(/\/en\/c\/[a-f0-9]{64}$/, { timeout: 20_000 });
    const newToken = page.url().split('/').pop()!;
    const opened = await caseByToken(t, newToken);
    const attribution = await referralOf(t, opened!.tenantId, opened!.caseId);
    expect(attribution.referredBy).toBe(code);
    expect(elsewhere(requests)).toEqual([]);
    expect(await context.cookies()).toEqual([]);
    // The referrer sees the count, and only the count.
    await page.goto(`${BASE}/en/c/${token}`);
    expect(await page.locator('[data-referrals]').getAttribute('data-referrals')).toBe('1');
    expect(await page.locator('[data-referral]').count()).toBe(0);
    await context.close();
  }, 300_000);

  it('the benchmark comes from the canary corpus and says how many sites it rests on', async () => {
    const page = await browser.newPage();
    await page.goto(`${BASE}/en/c/${token}`);
    const line = page.locator('[data-benchmark]');
    expect(await line.count()).toBe(1);
    expect(await line.getAttribute('data-benchmark-n')).toBe('40');
    const share = Number(await line.getAttribute('data-benchmark-share'));
    expect(share).toBeGreaterThan(0);
    expect(share).toBeLessThanOrEqual(100);
    const text = await line.innerText();
    expect(text).toContain('40');
    expect(text).toContain(`${share}%`);
    expect(text).toContain('2026-09-03');
    // Too few sites, and the number is withheld rather than dressed up.
    writeFileSync(
      BENCHMARK,
      JSON.stringify({ date: '2026-09-03', n: 8, counts: [1, 2, 3, 4, 5, 6, 7, 8] }),
    );
    await page.reload();
    const small = page.locator('[data-benchmark]');
    expect(await small.getAttribute('data-benchmark-n')).toBe('8');
    expect(await small.getAttribute('data-benchmark-share')).toBeNull();
    expect(await small.innerText()).toContain('8');
    await page.close();
  }, 120_000);
});
