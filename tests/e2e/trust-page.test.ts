import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Locator } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appendCaseEvent,
  caseTimeline,
  createTestDatabase,
  openCase,
  schema,
  seedRemedies,
  testDatabaseUrl,
  trustStatus,
  withTenant,
  type TestDatabase,
} from '@gc/db';
import { bindingFor } from '@gc/findings';
import { loadCatalogue } from '@gc/remedies';

// The public progress page (U-05), in a real browser: off until the holder publishes it,
// on the timeline both ways; dated work in progress in words that never claim a seal;
// what was fixed and when, a count of what is open and never which; and the way in for
// the next company.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WEB = join(ROOT, 'apps', 'web');
const PORT = 3425;
const BASE = `http://127.0.0.1:${PORT}`;
const next = join(WEB, 'node_modules', 'next', 'dist', 'bin', 'next');
const url = testDatabaseUrl();
const T0 = new Date('2026-08-20T09:00:00Z');
const T1 = new Date('2026-08-27T09:00:00Z');
const CHECKED = new Date('2026-09-01T04:30:00Z');

// Claim discipline (O-03): none of these may appear on the page a company links to.
const BANNED = [
  'certified',
  'certificate',
  'approved by',
  'fully compliant',
  'guaranteed',
  'compliant',
];

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

const FINDINGS = [
  { id: 'f-hsts', type: 'SEC-03', remedy: 'sec-03-hsts', area: 'Security', closedAt: T0 },
  { id: 'f-tags', type: 'CNS-02', remedy: 'cns-02-gate-tags', area: 'Consent', closedAt: T1 },
  { id: 'f-tick', type: 'FRM-01', remedy: 'frm-01-untick-the-box', area: 'Collection' },
] as const;

describe.skipIf(!url)('the public progress page (U-05)', () => {
  let t: TestDatabase;
  let server: ChildProcess | undefined;
  let browser: Browser;
  let token = '';
  let caseId = '';
  let tenantId = '';
  const catalogue = loadCatalogue();
  const title = (remedy: string) => catalogue.get(remedy)!.remedy.title.en;

  beforeAll(async () => {
    t = await createTestDatabase(url);
    await seedRemedies(t, catalogue);
    const opened = await openCase(t, {
      company: {
        domain: 'eksempelbutik.dk',
        legalName: 'Eksempelbutik ApS',
        country: 'DK',
        locale: 'da',
      },
      jurisdiction: 'DK',
      locale: 'da',
    });
    caseId = opened.caseId;
    tenantId = opened.tenantId;
    token = opened.accessToken;
    for (const f of FINDINGS) {
      const entry = catalogue.get(f.remedy)!;
      const closedAt = 'closedAt' in f ? f.closedAt : undefined;
      await withTenant(t, tenantId, (db) =>
        db.insert(schema.findings).values({
          id: f.id,
          tenantId,
          sourceRef: 'test',
          caseId,
          typeId: f.type,
          fingerprint: `${f.type}|x`,
          jurisdiction: 'DK',
          binding: bindingFor(f.type, 'DK'),
          severity: 'serious',
          status: closedAt ? 'closed' : 'open',
          area: f.area,
          remedyId: f.remedy,
          remedyVersion: entry.remedy.version,
          firstSeenAt: T0,
          lastSeenAt: closedAt ?? T1,
          ...(closedAt ? { closedAt } : {}),
        }),
      );
    }
    await withTenant(t, tenantId, (db) =>
      appendCaseEvent(db, {
        tenantId,
        caseId,
        at: CHECKED,
        actor: { kind: 'watcher' },
        type: 'scan_completed',
        payload: { scanId: 'scan-w1', checksRun: 9, checksPassed: 8, findings: 1, undetermined: 0 },
      }),
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
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    server?.kill();
    await t?.drop();
  });

  it('is off by default: no slug, nothing public, and the case page says so', async () => {
    expect(await trustStatus(t, tenantId, caseId)).toEqual({ slug: null, publishedAt: null });
    const page = await browser.newPage();
    await page.goto(`${BASE}/en/c/${token}`);
    const section = page.locator('section.trust-toggle');
    expect(await section.getAttribute('data-trust-status')).toBe('off');
    expect(await text(section)).toMatch(/not published/i);
    expect(await section.locator('a[data-trust-link]').count()).toBe(0);
    expect(await section.locator('form[action$="/trust/publish"]').count()).toBe(1);
    // A guess at a slug finds nothing.
    const guess = await page.request.get(`${BASE}/en/t/0123456789abcdef`);
    expect(guess.status()).toBe(404);
    await page.close();
  });

  it('publishing is an explicit act on the timeline, and the page reads as dated work in progress', async () => {
    const page = await browser.newPage();
    await page.goto(`${BASE}/en/c/${token}`);
    await page.locator('section.trust-toggle form[action$="/trust/publish"] button').click();
    await page.waitForURL(/trust=published/);
    expect(new URL(page.url()).pathname).toBe(`/en/c/${token}`);
    const section = page.locator('section.trust-toggle');
    expect(await section.getAttribute('data-trust-status')).toBe('on');
    const link = section.locator('a[data-trust-link]');
    const href = (await link.getAttribute('href')) ?? '';
    expect(href).toMatch(/^\/en\/t\/[a-f0-9]{16}$/);
    const status = await trustStatus(t, tenantId, caseId);
    expect(href.endsWith(status.slug ?? '?')).toBe(true);
    const events = await withTenant(t, tenantId, (db) => caseTimeline(db, caseId));
    const published = events.filter((e) => e.type === 'trust_published');
    expect(published).toHaveLength(1);
    expect(published[0]!.payload).toEqual({ slug: status.slug });
    expect(published[0]!.actor.kind).toBe('person');

    // The public page, as a stranger sees it: a fresh context, no token anywhere.
    const stranger = await browser.newContext();
    const pub = await stranger.newPage();
    const response = await pub.goto(`${BASE}${href}`);
    expect(response?.status()).toBe(200);
    const html = await pub.content();
    expect(html).not.toContain(token);
    expect(html).not.toMatch(/\/c\//);
    const card = pub.locator('.trust-card');
    expect(await text(card.locator('h1'))).toBe('Eksempelbutik ApS · privacy work in progress');
    const meta = await text(card.locator('.meta'));
    expect(meta).toMatch(/Last checked .*1 September 2026/);
    expect(meta).toMatch(/Page published .*2026/);
    expect(meta).toContain(`Case ${caseId}`);
    expect(meta).toContain('Checked by GDPRcompliant.eu');
    const statement = await text(card.locator('.trust-st'));
    expect(statement).toMatch(/work in progress/i);
    expect(statement).toMatch(/not a seal/i);
    expect(statement).toMatch(/nobody has approved/i);
    // Fixed, dated, in the words of the remedy that closed it, newest first.
    const items = card.locator('.trust-list li');
    expect(await items.count()).toBe(2);
    expect(await text(items.nth(0))).toContain(title('cns-02-gate-tags'));
    expect(await text(items.nth(0))).toContain('27 August 2026');
    expect(await text(items.nth(1))).toContain(title('sec-03-hsts'));
    expect(await text(items.nth(1))).toContain('20 August 2026');
    // The open finding is theirs alone: a count, never a name.
    const body = await text(pub.locator('article.trust'));
    expect(body).not.toContain(title('frm-01-untick-the-box'));
    expect(body).not.toMatch(/FRM-01|CNS-02|SEC-03/);
    expect(await text(card.locator('[data-open-note]'))).toBe(
      '1 item is open. Ask the company and they will tell you what it is.',
    );
    // Never a seal, in any of the words a seal uses.
    // The brand is the one place the word may stand; nowhere else, and never as a verdict.
    const words = body.toLowerCase().replaceAll('gdprcompliant.eu', '');
    for (const banned of BANNED) expect(words).not.toContain(banned);
    expect(words).not.toMatch(/gdpr[ -]compliant/);
    expect(await pub.locator('.sev, .step, .rem-card').count()).toBe(0);
    // The growth loop: the way in for the next company.
    const cta = card.locator('a[data-cta]');
    expect(await text(cta)).toBe('Check your own website');
    expect(await cta.getAttribute('href')).toBe('/en');
    await cta.click();
    await pub.waitForURL(/\/en$/);
    expect(await text(pub.locator('.fd h1'))).toMatch(/GDPR/);
    await stranger.close();
    await page.close();
  });

  it('publishing again changes nothing; taking it down is as explicit, and the link answers nothing', async () => {
    const before = await trustStatus(t, tenantId, caseId);
    const page = await browser.newPage();
    // A second publish is idempotent: same slug, no second event.
    const again = await page.request.post(`${BASE}/en/c/${token}/trust/publish`, {
      maxRedirects: 0,
    });
    expect(again.status()).toBe(303);
    expect(again.headers()['location']).toContain('trust=already');
    expect(await trustStatus(t, tenantId, caseId)).toEqual(before);

    await page.goto(`${BASE}/en/c/${token}`);
    await page.locator('section.trust-toggle form[action$="/trust/unpublish"] button').click();
    await page.waitForURL(/trust=unpublished/);
    const section = page.locator('section.trust-toggle');
    expect(await section.getAttribute('data-trust-status')).toBe('off');
    const gone = await page.request.get(`${BASE}/en/t/${before.slug}`);
    expect(gone.status()).toBe(404);
    const events = await withTenant(t, tenantId, (db) => caseTimeline(db, caseId));
    expect(events.filter((e) => e.type === 'trust_published')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'trust_unpublished')).toHaveLength(1);
    // Back up: the same link works again, so what a company put on its site holds.
    await page.locator('section.trust-toggle form[action$="/trust/publish"] button').click();
    await page.waitForURL(/trust=published/);
    const back = await page.request.get(`${BASE}/en/t/${before.slug}`);
    expect(back.status()).toBe(200);
    await page.close();
  });

  it('reads in Danish on the Danish route, with the same discipline', async () => {
    const status = await trustStatus(t, tenantId, caseId);
    const page = await browser.newPage();
    await page.goto(`${BASE}/da/t/${status.slug}`);
    expect(await text(page.locator('.trust-card h1'))).toContain('privatlivsarbejde i gang');
    expect(await text(page.locator('.trust-st'))).toMatch(/ikke et mærke/);
    expect(await text(page.locator('[data-open-note]'))).toMatch(/^1 punkt er åbent/);
    const body = (await text(page.locator('article.trust'))).toLowerCase();
    for (const banned of ['certificeret', 'certifikat', 'godkendt af', 'garanteret']) {
      expect(body).not.toContain(banned);
    }
    await page.close();
  });
});
