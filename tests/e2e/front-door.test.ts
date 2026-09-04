import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Locator } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, seedRemedies, testDatabaseUrl, type TestDatabase } from '@gc/db';
import { JobQueue } from '@gc/jobs';
import { loadCatalogue } from '@gc/remedies';
import { BrowserPool, FixtureServer, loadFixtureSites } from '@gc/scanner';
import { registerScanWorker } from '@gc/worker';

// The front door (U-02), in a real browser on a phone-sized screen: one field, one
// button, no account; a domain typed however it comes; the scan's real stages as the
// worker marks them; the case at the end. And the refusals: a bad address, too many
// scans from one source, a full queue.

const url = (() => {
  try {
    return testDatabaseUrl();
  } catch (e) {
    if (process.env['CI']) throw e;
    console.warn((e as Error).message);
    return undefined;
  }
})();

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WEB = join(ROOT, 'apps', 'web');
const ARTIFACTS = join(ROOT, 'artifacts');
const PORT = 3421;
const BASE = `http://127.0.0.1:${PORT}`;
const next = join(WEB, 'node_modules', 'next', 'dist', 'bin', 'next');

const text = async (locator: Locator): Promise<string> => {
  await locator.first().waitFor({ timeout: 15_000 });
  return locator.first().innerText();
};

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

describe.skipIf(!url)('the front door (U-02)', () => {
  let t: TestDatabase;
  let server: ChildProcess | undefined;
  let browser: Browser;
  let fixtures: FixtureServer;
  let pool: BrowserPool;
  let queue: JobQueue;

  beforeAll(async () => {
    t = await createTestDatabase(url!);
    await seedRemedies(t, loadCatalogue());
    // The worker, in this process, scanning the fixture estate through its proxy.
    const sites = loadFixtureSites();
    fixtures = await new FixtureServer(sites.flatMap((s) => s.hosts)).start();
    pool = await new BrowserPool({
      concurrency: 2,
      passTimeoutMs: 60_000,
      navigationTimeoutMs: 10_000,
      launch: { proxy: { server: fixtures.proxy } },
      ignoreHTTPSErrors: true,
    }).start();
    queue = new JobQueue({ connectionString: url!, pollingIntervalSeconds: 1 });
    await queue.start();
    await registerScanWorker(queue, t, {
      pool,
      catalogue: loadCatalogue(),
      quiet: { minDwellMs: 800, quietMs: 400, maxWaitMs: 8_000 },
    });

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
        DATABASE_URL: url!,
        GC_SEARCH_PATH: `${t.schema},public`,
        APP_BASE_URL: BASE,
        GC_SCANS_PER_SOURCE_PER_HOUR: '3',
      },
    });
    if (process.env['GC_E2E_LOG'] === '1') {
      server.stdout?.on('data', (d) => process.stdout.write(String(d)));
      server.stderr?.on('data', (d) => process.stderr.write(String(d)));
    }
    await waitFor(`${BASE}/en`, 60_000);
    browser = await chromium.launch();
  }, 240_000);

  afterAll(async () => {
    await browser?.close();
    server?.kill();
    await queue?.stop({ graceful: false });
    await pool?.stop();
    await fixtures?.stop();
    await t?.drop();
  });

  it('starts a scan from the keyboard alone, on a phone, and shows the scan as it happens until the case is ready', async () => {
    const context = await browser.newContext({
      viewport: { width: 375, height: 812 },
      isMobile: true,
      hasTouch: true,
    });
    const startedAt = Date.now();
    const page = await context.newPage();
    await page.goto(`${BASE}/en`);
    // Nothing wider than the phone.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    expect(await text(page.locator('.fd h1'))).toMatch(/GDPR/);

    // Tab to the field, type a domain the way people do, press Enter.
    await page.keyboard.press('Tab');
    let focused = await page.evaluate(() => document.activeElement?.getAttribute('name'));
    for (let i = 0; i < 6 && focused !== 'domain'; i += 1) {
      await page.keyboard.press('Tab');
      focused = await page.evaluate(() => document.activeElement?.getAttribute('name'));
    }
    expect(focused).toBe('domain');
    await page.keyboard.type('  HTTPS://Usikker.TEST/kontakt?x=1 ');
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/en\/scan\/[^/]+$/, { timeout: 20_000 });
    expect((await text(page.locator('.eyebrow'))).toLowerCase()).toBe('usikker.test');

    // Real stages, marked by the worker; no percentage anywhere.
    const steps = page.locator('.scan-step');
    expect(await steps.count()).toBe(10);
    await page.locator('.scan-step.ok[data-stage="opening"]').waitFor({ timeout: 60_000 });
    await page.locator('.scan-steps[data-done]').waitFor({ timeout: 120_000 });
    const dead = (await queue.deadLetters((await import('@gc/db')).SCAN_JOB)).filter(
      (d) => d.failedAt.getTime() >= startedAt,
    );
    expect(
      dead.map((d) => d.reason),
      'the scan job must not have died',
    ).toEqual([]);
    const body = await page.locator('body').innerText();
    expect(body).not.toMatch(/\d+\s?%/);
    const marks = await steps.evaluateAll((els) =>
      els.map((el) => ({
        stage: el.getAttribute('data-stage'),
        mark: [...el.classList].find((c) => c !== 'scan-step'),
      })),
    );
    expect(marks.find((m) => m.stage === 'opening')?.mark).toBe('ok');
    expect(marks.find((m) => m.stage === 'security')?.mark).toBe('ok');
    expect(marks.find((m) => m.stage === 'writing-up')?.mark).toBe('ok');
    expect(marks.find((m) => m.stage === 'banner')?.mark).toBe('na');

    // The case, one tap away.
    const out = page.locator('.scan-out');
    expect(await text(out.locator('h3'))).toMatch(/case is ready|do not need a cookie banner/);
    await out.locator('a.btn').click();
    await page.waitForURL(/\/en\/c\/[a-f0-9]{64}$/, { timeout: 20_000 });
    expect(await page.locator('body').innerText()).toMatch(/DK-\d{2}-[23456789A-Z]{4}/);
    await context.close();
  });

  it('refuses a bad address politely and stays on the front door', async () => {
    const page = await browser.newPage();
    await page.goto(`${BASE}/en`);
    await page.fill('input[name="domain"]', 'hello there');
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/en\?outcome=invalid$/, { timeout: 10_000 });
    expect(await text(page.locator('[role="alert"]'))).toMatch(
      /does not look like a website address/,
    );
    expect(await page.locator('input[name="domain"]').count()).toBe(1);
    await page.close();
  });

  it('limits scans per source and says when to come back; the worker never sees the refused ones', async () => {
    const before = await queue.depth((await import('@gc/db')).SCAN_JOB);
    const page = await browser.newPage();
    const outcomes: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      await page.goto(`${BASE}/da`);
      await page.fill('input[name="domain"]', `refused-${i}.test`);
      const submittedFrom = page.url();
      await page.keyboard.press('Enter');
      await page.waitForURL((u) => u.toString() !== submittedFrom, { timeout: 15_000 });
      outcomes.push(new URL(page.url()).searchParams.get('outcome') ?? 'started');
    }
    // Three scans in the hour from this source were already used up by the first test
    // and these; the last is refused with a Danish message.
    expect(outcomes.at(-1)).toBe('limited');
    expect(await text(page.locator('[role="alert"]'))).toMatch(/seneste time/);
    const after = await queue.depth((await import('@gc/db')).SCAN_JOB);
    expect(after - before).toBeLessThanOrEqual(2);
    await page.close();
  });
});
