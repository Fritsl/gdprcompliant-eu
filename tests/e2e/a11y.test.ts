import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, seedRemedies, testDatabaseUrl, type TestDatabase } from '@gc/db';
import { JobQueue } from '@gc/jobs';
import { loadCatalogue } from '@gc/remedies';
import { BrowserPool, FixtureServer, loadFixtureSites, type FixtureHost } from '@gc/scanner';
import { registerRecheckWorker, registerScanWorker } from '@gc/worker';

// The whole surface audited (U-08), in a real browser against the fixture estate: axe on
// every route with zero serious or critical violations; a full journey, scan to
// re-check, completed with the keyboard alone; reduced motion honoured and nothing
// said by colour alone; and the case page, evidence open, printed to A4 without
// overflow.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WEB = join(ROOT, 'apps', 'web');
const ARTIFACTS = join(ROOT, 'artifacts');
const PORT = 3431;
const BASE = `http://127.0.0.1:${PORT}`;
const next = join(WEB, 'node_modules', 'next', 'dist', 'bin', 'next');
const url = testDatabaseUrl();
const AXE = join(
  ROOT,
  'node_modules',
  '.pnpm',
  'axe-core@4.13.0',
  'node_modules',
  'axe-core',
  'axe.min.js',
);

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

// Press Tab until the element is focused, or give up: the keyboard has to reach it.
async function tabTo(page: Page, selector: string, max = 80): Promise<void> {
  for (let i = 0; i < max; i++) {
    if (await page.evaluate((s) => document.activeElement?.matches(s) ?? false, selector)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`the keyboard could not reach ${selector} in ${max} tabs`);
}

interface Violation {
  id: string;
  impact: string | null;
  help: string;
  nodes: { target: string[] }[];
}
async function axeViolations(page: Page): Promise<string[]> {
  await page.addScriptTag({ content: readFileSync(AXE, 'utf8') });
  const violations = (await page.evaluate(async () => {
    const axe = (
      window as unknown as {
        axe: { run: (c: Document, o: unknown) => Promise<{ violations: Violation[] }> };
      }
    ).axe;
    const r = await axe.run(document, { resultTypes: ['violations'] });
    return r.violations;
  })) as Violation[];
  return violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map(
      (v) => `${v.impact} ${v.id}: ${v.help} (${v.nodes.length}: ${v.nodes[0]?.target.join(' ')})`,
    );
}

describe.skipIf(!url)('the whole surface audited (U-08)', () => {
  let t: TestDatabase;
  let server: ChildProcess | undefined;
  let browser: Browser;
  let fixtures: FixtureServer;
  let pool: BrowserPool;
  let queue: JobQueue;
  const liveHeaders: Record<string, string> = {};
  let token = '';
  let scanUrl = '';
  const extraRoutes: string[] = [];

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
  });

  it('a full journey with the keyboard alone: scan, read, fix, re-check', async () => {
    const page = await browser.newPage();
    await page.goto(`${BASE}/en`);
    await tabTo(page, 'input[name="domain"]');
    await page.keyboard.type('usikker.test');
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/en\/scan\/[^/]+$/, { timeout: 20_000 });
    scanUrl = page.url();
    await page.locator('.scan-steps[data-done]').waitFor({ timeout: 120_000 });
    await tabTo(page, '.scan-out a.btn');
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/en\/c\/[a-f0-9]{64}$/, { timeout: 20_000 });
    token = page.url().split('/').pop()!;

    // Read: the evidence drawer opens from the keyboard.
    const step = page.locator('li.step[data-type="SEC-03"]');
    expect(await step.getAttribute('data-status')).toBe('open');
    const drawer = step.locator('details.evidence');
    await page.evaluate(() => {
      for (const d of document.querySelectorAll('details.evidence'))
        (d as HTMLDetailsElement).open = false;
    });
    await tabTo(page, 'li.step[data-type="SEC-03"] details.evidence summary');
    await page.keyboard.press('Enter');
    expect(await drawer.evaluate((d) => (d as HTMLDetailsElement).open)).toBe(true);
    expect(await drawer.innerText()).toMatch(/usikker\.test/);

    // Fix, then re-check from the keyboard, and watch it close.
    liveHeaders['strict-transport-security'] = 'max-age=63072000; includeSubDomains';
    await tabTo(page, 'li.step[data-type="SEC-03"] form.step-act button');
    await page.keyboard.press('Enter');
    await page.waitForURL(/recheck=/);
    const report = page.locator('li.step[data-type="SEC-03"] [role=status]');
    await expect
      .poll(() => report.getAttribute('data-recheck'), { timeout: 120_000 })
      .not.toBe('running');
    expect(await report.getAttribute('data-recheck')).toBe('closed');
    await expect
      .poll(() => page.locator('li.step[data-type="SEC-03"]').getAttribute('data-status'), {
        timeout: 20_000,
      })
      .toBe('closed');
    await page.close();
  }, 300_000);

  it('every route passes axe with no serious or critical violation', async () => {
    const page = await browser.newPage();
    const base = `${BASE}/en/c/${token}`;
    // Open the routes that exist only after an action: an invitation, a share, the public page.
    await page.goto(base);
    await page.fill('form.invite input[name="from"]', 'Mette');
    await page.fill('form.invite input[name="email"]', 'lars@usikker.test');
    await page.selectOption('form.invite select[name="role"]', 'it');
    await page.locator('form.invite button[type="submit"]').click();
    await page.waitForLoadState('load');
    const invite = await page.locator('[data-invite-link]').first().getAttribute('href');
    if (invite) extraRoutes.push(invite);
    await page.fill('input[name="audience"]', 'The board');
    await page.locator('form[action$="/share/create"] button[type="submit"]').click();
    await page.waitForLoadState('load');
    const share = await page.locator('[data-share-link]').first().getAttribute('href');
    if (share) extraRoutes.push(share);
    await page.locator('form[action$="/trust/publish"] button[type="submit"]').click();
    await page.waitForLoadState('load');
    const trust = await page.locator('[data-trust-link]').first().getAttribute('href');
    if (trust) extraRoutes.push(trust);
    expect(extraRoutes.length).toBe(3);
    const absolute = extraRoutes.map((h) => (h.startsWith('http') ? h : `${BASE}${h}`));

    const routes = [
      `${BASE}/en`,
      `${BASE}/da`,
      `${BASE}/de`,
      `${BASE}/en/guides`,
      `${BASE}/en/guides/sec-03`,
      `${BASE}/de/guides/sec-03`,
      `${BASE}/en/ourselves`,
      `${BASE}/en/demand`,
      scanUrl,
      base,
      `${BASE}/da/c/${token}`,
      `${base}/register`,
      `${base}/questions`,
      `${base}/timeline`,
      `${base}/artefacts/privacy_policy`,
      ...absolute,
    ];
    const failures: string[] = [];
    for (const route of routes) {
      const r = await page.goto(route);
      expect(r?.status(), route).toBe(200);
      for (const v of await axeViolations(page)) failures.push(`${route.replace(BASE, '')}: ${v}`);
    }
    expect(failures).toEqual([]);
    await page.close();
  }, 300_000);

  it('reduced motion is honoured, and status and severity are said in words, not colour alone', async () => {
    const page = await browser.newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const route of [`${BASE}/en/c/${token}`, scanUrl, `${BASE}/en`]) {
      await page.goto(route);
      const moving = await page.evaluate(() =>
        [...document.querySelectorAll('*')]
          .filter((el) => {
            const s = getComputedStyle(el);
            return (
              s.animationName !== 'none' ||
              (s.transitionDuration !== '0s' && s.transitionDuration !== '')
            );
          })
          .slice(0, 5)
          .map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`),
      );
      expect(moving, route).toEqual([]);
    }
    await page.goto(`${BASE}/en/c/${token}`);
    const steps = page.locator('li.step');
    expect(await steps.count()).toBeGreaterThan(0);
    for (let i = 0; i < (await steps.count()); i++) {
      const step = steps.nth(i);
      const severity = await step.getAttribute('data-severity');
      const status = await step.getAttribute('data-status');
      const label = (await step.locator('.sev').first().innerText()).trim();
      expect(label, `step ${i} (${severity}, ${status})`).toMatch(
        /blocking|serious|advisory|fixed/i,
      );
      // The marker is a shape as well as a colour.
      const marker = await step
        .locator('.sev')
        .first()
        .evaluate((el) => getComputedStyle(el, '::before').content);
      expect(marker, `step ${i}`).not.toBe('none');
    }
    const recheck = page.locator('[role=status][data-recheck]').first();
    if ((await recheck.count()) > 0)
      expect((await recheck.innerText()).trim().length).toBeGreaterThan(3);
    await page.close();
  }, 120_000);

  it('the case page and its evidence print to A4 without overflow', async () => {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 794, height: 1123 });
    await page.emulateMedia({ media: 'print' });
    await page.goto(`${BASE}/en/c/${token}`);
    const print = await page.evaluate(() => {
      const hidden = (s: string) =>
        [...document.querySelectorAll(s)].every((el) => getComputedStyle(el).display === 'none');
      const root = document.documentElement;
      const pres = [...document.querySelectorAll('details.evidence pre')];
      return {
        noPrintHidden: hidden('.no-print'),
        formsHidden: hidden('.case form, .step-act'),
        evidenceOpen: [...document.querySelectorAll('details.evidence')].every(
          (d) => (d as HTMLDetailsElement).open,
        ),
        evidenceVisible:
          pres.length > 0 && pres.every((p) => getComputedStyle(p).display !== 'none'),
        overflow: root.scrollWidth - root.clientWidth,
        preOverflow: pres.filter((p) => p.scrollWidth > p.clientWidth + 1).length,
        steps: document.querySelectorAll('li.step').length,
      };
    });
    expect(print).toMatchObject({
      noPrintHidden: true,
      formsHidden: true,
      evidenceOpen: true,
      evidenceVisible: true,
      preOverflow: 0,
    });
    expect(print.overflow).toBeLessThanOrEqual(1);
    expect(print.steps).toBeGreaterThan(0);
    const pdf = join(ARTIFACTS, 'a11y-case-a4.pdf');
    await page.pdf({
      path: pdf,
      format: 'A4',
      printBackground: true,
      margin: { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' },
    });
    expect(statSync(pdf).size).toBeGreaterThan(10_000);
    await page.close();
  }, 120_000);
});
