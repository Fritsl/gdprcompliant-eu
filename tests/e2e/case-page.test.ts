import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256, type Evidence } from '@gc/contracts';
import {
  createTestDatabase,
  openCase,
  schema,
  seedRemedies,
  storeEvidence,
  storeFindings,
  testDatabaseUrl,
  withTenant,
  type TestDatabase,
} from '@gc/db';
import { raiseFindings } from '@gc/findings';
import { loadCatalogue } from '@gc/remedies';
import { eq } from 'drizzle-orm';

// The case page (U-03), in a real browser: no score in the header, a fixes-ready count
// and a progress track instead; every finding opens to the raw evidence that produced
// it; severity is a shape as well as a colour; and the page prints.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WEB = join(ROOT, 'apps', 'web');
const ARTIFACTS = join(ROOT, 'artifacts');
const PORT = 3423;
const BASE = `http://127.0.0.1:${PORT}`;
const next = join(WEB, 'node_modules', 'next', 'dist', 'bin', 'next');
const url = testDatabaseUrl();
const T0 = new Date('2026-09-04T09:00:00Z');

const text = async (locator: Locator): Promise<string> => {
  await locator.first().waitFor({ timeout: 10_000 });
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

const BODIES = {
  hsts: 'HTTP/1.1 200 OK\r\ncontent-type: text/html\r\nx-frame-options: DENY\r\n(no strict-transport-security header)',
  tags: '{"host":"www.googletagmanager.com","requests":{"reject":4,"accept":4},"same":true}',
  server: 'server: nginx/1.18.0 (Ubuntu)',
} as const;

function row(
  ctx: { tenantId: string; caseId: string },
  kind: Evidence['kind'],
  body: string,
  caption: string,
): Evidence {
  const hash = sha256(body);
  return {
    id: `${kind}:${hash.slice(0, 16)}`,
    tenantId: ctx.tenantId,
    caseId: ctx.caseId,
    scanId: 'scan-u03',
    kind,
    capturedAt: T0.toISOString(),
    source: { url: 'https://eksempelbutik.dk/', host: 'eksempelbutik.dk', pass: 'A' },
    body,
    hash,
    caption,
  };
}

const pseudoStyle = (page: Page, selector: string, prop: string) =>
  page.evaluate(
    ([s, p]) => {
      const el = document.querySelector(s as string);
      return el ? getComputedStyle(el, '::before').getPropertyValue(p as string) : '';
    },
    [selector, prop],
  );

describe.skipIf(!url)('the case page (U-03)', () => {
  let t: TestDatabase;
  let server: ChildProcess | undefined;
  let browser: Browser;
  let token = '';
  let closedId = '';
  let blockingId = '';

  beforeAll(async () => {
    t = await createTestDatabase(url);
    const catalogue = loadCatalogue();
    await seedRemedies(t, catalogue);
    const opened = await openCase(t, {
      company: { domain: 'eksempelbutik.dk', country: 'DK', locale: 'da' },
      jurisdiction: 'DK',
      locale: 'da',
    });
    token = opened.accessToken;
    const ctx = { tenantId: opened.tenantId, caseId: opened.caseId };
    const hsts = row(ctx, 'header', BODIES.hsts, 'Response headers of the home page');
    const tags = row(ctx, 'pass_diff', BODIES.tags, 'Reject all against accept all');
    const server_ = row(ctx, 'header', BODIES.server, 'Server header');
    await storeEvidence(t, ctx.tenantId, [hsts, tags, server_]);
    const ref = (e: Evidence, quote?: string) => ({
      evidenceId: e.id,
      hash: e.hash,
      ...(quote ? { quote } : {}),
    });
    const findings = raiseFindings(
      [
        { typeId: 'SEC-03', evidence: [ref(hsts, 'strict-transport-security')] },
        {
          typeId: 'CNS-02',
          subject: { host: 'www.googletagmanager.com' },
          evidence: [ref(tags)],
        },
        { typeId: 'SEC-05', evidence: [ref(server_, 'nginx/1.18.0')] },
      ],
      { ...ctx, jurisdiction: 'DK', catalogue, scanId: 'scan-u03', now: () => T0 },
    );
    await storeFindings(t, ctx.tenantId, findings);
    closedId = findings.find((f) => f.typeId === 'SEC-05')!.id;
    blockingId = findings.find((f) => f.typeId === 'CNS-02')!.id;
    await withTenant(t, ctx.tenantId, (db) =>
      db
        .update(schema.findings)
        .set({ status: 'closed', closedAt: T0 })
        .where(eq(schema.findings.id, closedId)),
    );

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
    mkdirSync(ARTIFACTS, { recursive: true });
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    server?.kill();
    await t?.drop();
  });

  it('no score in the header: the case number, the domain, a fixes-ready count and a progress track', async () => {
    const page = await browser.newPage();
    await page.goto(`${BASE}/en/c/${token}`);
    const head = await text(page.locator('.plan-top'));
    expect(head).toMatch(/[A-Z]{2}-\d{2}-[A-Z0-9]{4}/);
    expect(head).toContain('eksempelbutik.dk');
    const lead = await text(page.locator('h1.plan-lead'));
    expect(lead).toBe('2 fixes ready');
    for (const s of [head, lead]) {
      expect(s).not.toMatch(/%|\/\s?100|score|grade/i);
    }
    const track = page.locator('.plan-prog');
    expect(await track.getAttribute('data-done')).toBe('1');
    expect(await track.getAttribute('data-total')).toBe('3');
    expect(await text(track.locator('.pp-txt'))).toMatch(/^1 of 3 done · about \d+ min left$/);
    const width = await track
      .locator('.pp-bar i')
      .evaluate((el) => (el as HTMLElement).style.width);
    expect(width).toBe('33%');
    // The page body carries no percentage either, outside the shared desk counts.
    const body = await text(page.locator('ol.steps'));
    expect(body).not.toMatch(/\d+\s?%/);
    await page.close();
  });

  it('the findings are steps, worst open first, exactly one to start on, and one primary button', async () => {
    const page = await browser.newPage();
    await page.goto(`${BASE}/en/c/${token}`);
    const steps = page.locator('ol.steps > li.step');
    expect(await steps.count()).toBe(3);
    expect(await steps.evaluateAll((els) => els.map((e) => e.getAttribute('data-type')))).toEqual([
      'CNS-02',
      'SEC-03',
      'SEC-05',
    ]);
    expect(await page.locator('li.step.now').count()).toBe(1);
    expect(await page.locator('li.step.now').getAttribute('data-finding')).toBe(blockingId);
    expect(await page.locator('li.step.done').getAttribute('data-finding')).toBe(closedId);
    expect(await page.locator('.case .btn:not(.btn-2)').count()).toBe(1);
    expect(await text(page.locator('li.step.now .step-kick'))).toMatch(/start here/i);
    // Every open finding shows its remedy with the rule it rests on.
    for (const f of await steps.all()) {
      expect(await f.locator('.rem-card').count()).toBe(1);
      expect(await f.locator('.rem-card h3, .step-body h3').first().innerText()).not.toBe('');
      expect(await f.locator('.cite').count()).toBeGreaterThan(0);
    }
    await page.close();
  });

  it('every finding opens to the raw evidence that produced it', async () => {
    const page = await browser.newPage();
    await page.goto(`${BASE}/en/c/${token}`);
    for (const [type, body] of [
      ['SEC-03', BODIES.hsts],
      ['CNS-02', BODIES.tags],
      ['SEC-05', BODIES.server],
    ] as const) {
      const step = page.locator(`li.step[data-type="${type}"]`);
      const drawer = step.locator('details.drawer.evidence');
      expect(await drawer.count()).toBe(1);
      // Closed, then opened: the drawer is a real control, and what it shows is the body
      // as stored, byte for byte where it is text.
      await drawer.evaluate((el) => ((el as HTMLDetailsElement).open = false));
      expect(await drawer.locator('pre.pre').first().isVisible()).toBe(false);
      await drawer.locator('summary').click();
      const shown = await drawer.locator('pre.pre').first().innerText();
      const expected = type === 'CNS-02' ? JSON.stringify(JSON.parse(body), null, 2) : body;
      expect(shown.replace(/\r/g, '')).toBe(expected.replace(/\r/g, ''));
      const cap = await drawer.locator('.ev-cap').first().innerText();
      expect(cap).toContain('eksempelbutik.dk');
      expect(cap).toMatch(/[a-f0-9]{12}/);
    }
    expect(await text(page.locator('li.step[data-type="SEC-03"] .ev-quote'))).toContain(
      'strict-transport-security',
    );
    await page.close();
  });

  it('severity is a shape as well as a colour', async () => {
    const page = await browser.newPage();
    await page.goto(`${BASE}/en/c/${token}`);
    const badge = (type: string) => `li.step[data-type="${type}"] .sev`;
    expect(await page.locator(badge('CNS-02')).getAttribute('class')).toContain('sev-blocking');
    expect(await page.locator(badge('SEC-03')).getAttribute('class')).toContain('sev-serious');
    expect(await page.locator(badge('SEC-05')).getAttribute('class')).toContain('sev-closed');
    // The word is in the badge, so it reads without any colour at all.
    expect(await text(page.locator(badge('CNS-02')))).toMatch(/blocking/i);
    expect(await text(page.locator(badge('SEC-03')))).toMatch(/serious/i);
    expect(await text(page.locator(badge('SEC-05')))).toMatch(/fixed/i);
    // And the mark differs in form: a square, a circle, a dot of a different size.
    const blocking = await pseudoStyle(page, badge('CNS-02'), 'border-radius');
    const serious = await pseudoStyle(page, badge('SEC-03'), 'border-radius');
    const closedW = await pseudoStyle(page, badge('SEC-05'), 'width');
    const seriousW = await pseudoStyle(page, badge('SEC-03'), 'width');
    expect(blocking).not.toBe(serious);
    expect(closedW).not.toBe(seriousW);
    const colours = await Promise.all(
      ['CNS-02', 'SEC-03', 'SEC-05'].map((t) =>
        page.locator(badge(t)).evaluate((el) => getComputedStyle(el).color),
      ),
    );
    expect(new Set(colours).size).toBe(3);
    await page.close();
  });

  it('the page is legible printed: the findings and their evidence stay, the forms go', async () => {
    const page = await browser.newPage();
    await page.goto(`${BASE}/en/c/${token}`);
    await page.emulateMedia({ media: 'print' });
    const display = (selector: string) =>
      page
        .locator(selector)
        .first()
        .evaluate((el) => getComputedStyle(el).display);
    expect(await display('ol.steps')).not.toBe('none');
    expect(await display('li.step[data-type="SEC-03"] details.drawer.evidence pre.pre')).not.toBe(
      'none',
    );
    expect(await display('.rem-card')).not.toBe('none');
    expect(await display('form.invite')).toBe('none');
    expect(await display('.colleagues')).toBe('none');
    expect(await display('.step-act')).toBe('none');
    // Long evidence wraps instead of running off the sheet.
    expect(
      await page
        .locator('li.step[data-type="SEC-03"] pre.pre')
        .first()
        .evaluate((el) => getComputedStyle(el).whiteSpace),
    ).toBe('pre-wrap');
    // The severity mark keeps its form in print.
    expect(await pseudoStyle(page, 'li.step[data-type="CNS-02"] .sev', 'width')).not.toBe('0px');
    const pdf = await page.pdf({ path: join(ARTIFACTS, 'case-page.pdf'), format: 'A4' });
    expect(pdf.byteLength).toBeGreaterThan(10_000);
    await page.close();
  });

  it('check it again leaves the finding open and says so; the Danish page reads in Danish', async () => {
    const page = await browser.newPage();
    await page.goto(`${BASE}/da/c/${token}`);
    expect(await text(page.locator('h1.plan-lead'))).toBe('2 rettelser klar');
    expect(await text(page.locator('.pp-txt'))).toMatch(/^1 af 3 færdige/);
    await page.locator('li.step.now form.step-act button').click();
    await page.waitForURL(/recheck=/);
    // No worker runs here, so the honest report is that the check is still running.
    expect(await text(page.locator('li.step.now [role=status]'))).toBe('Tjekker sitet igen');
    expect(await page.locator('li.step.now [role=status]').getAttribute('data-recheck')).toBe(
      'running',
    );
    expect(await page.locator('li.step.now').getAttribute('data-finding')).toBe(blockingId);
    await page.close();
  });
});
