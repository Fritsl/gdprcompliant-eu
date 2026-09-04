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
  withTenant,
  type TestDatabase,
} from '@gc/db';
import { bindingFor } from '@gc/findings';
import { loadCatalogue } from '@gc/remedies';

// Share flows (U-07), in a real browser: inward to a colleague in the inviter's name,
// landing on their own list; upward as a one-screen summary that shows progress and
// never a grade; outward as the public page. Every share is on the timeline and every
// share can be taken back.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WEB = join(ROOT, 'apps', 'web');
const PORT = 3426;
const BASE = `http://127.0.0.1:${PORT}`;
const next = join(WEB, 'node_modules', 'next', 'dist', 'bin', 'next');
const url = testDatabaseUrl();
const T0 = new Date('2026-08-20T09:00:00Z');
const T1 = new Date('2026-08-27T09:00:00Z');
const CHECKED = new Date('2026-09-01T04:30:00Z');

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

// Two fixed, three open across three weights and three desks.
const FINDINGS = [
  {
    id: 'f-hsts',
    type: 'SEC-03',
    remedy: 'sec-03-hsts',
    area: 'Security',
    severity: 'serious',
    closedAt: T0,
  },
  {
    id: 'f-tags',
    type: 'CNS-02',
    remedy: 'cns-02-gate-tags',
    area: 'Consent',
    severity: 'blocking',
    closedAt: T1,
  },
  {
    id: 'f-cns1',
    type: 'CNS-01',
    remedy: 'cns-01-gate-before-interaction',
    area: 'Consent',
    severity: 'blocking',
  },
  {
    id: 'f-tick',
    type: 'FRM-01',
    remedy: 'frm-01-untick-the-box',
    area: 'Collection',
    severity: 'serious',
  },
  {
    id: 'f-ref',
    type: 'SEC-05',
    remedy: 'sec-05-referrer-policy',
    area: 'Security',
    severity: 'advisory',
  },
] as const;

describe.skipIf(!url)('share flows (U-07)', () => {
  let t: TestDatabase;
  let server: ChildProcess | undefined;
  let browser: Browser;
  let token = '';
  let caseId = '';
  let tenantId = '';
  const catalogue = loadCatalogue();
  const title = (remedy: string) => catalogue.get(remedy)!.remedy.title.en;
  const events = () => withTenant(t, tenantId, (db) => caseTimeline(db, caseId));

  beforeAll(async () => {
    t = await createTestDatabase(url);
    await seedRemedies(t, catalogue);
    const opened = await openCase(t, {
      company: { domain: 'eksempelbutik.dk', country: 'DK', locale: 'da' },
      jurisdiction: 'DK',
      locale: 'da',
    });
    caseId = opened.caseId;
    tenantId = opened.tenantId;
    token = opened.accessToken;
    for (const f of FINDINGS) {
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
          severity: f.severity,
          status: closedAt ? 'closed' : 'open',
          area: f.area,
          remedyId: f.remedy,
          remedyVersion: catalogue.get(f.remedy)!.remedy.version,
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
        payload: { scanId: 'scan-w1', checksRun: 9, checksPassed: 6, findings: 3, undetermined: 0 },
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

  it('inward: the invitation comes from the colleague in their name and lands on a scoped view; withdrawing kills it', async () => {
    const owner = await browser.newPage();
    await owner.goto(`${BASE}/en/c/${token}#colleagues`);
    await owner.fill('form.invite input[name="from"]', 'Mette');
    await owner.fill('form.invite input[name="email"]', 'lars@eksempelbutik.dk');
    await owner.selectOption('form.invite select[name="role"]', 'it');
    await owner.locator('form.invite button[type=submit]').click();
    await owner.waitForURL(new RegExp(`/en/c/${token}`));
    const link = (await owner.locator('a[data-invite-link]').first().getAttribute('href')) ?? '';
    expect(link).toMatch(/\/en\/m\/[0-9a-f]{32,}/);
    const invited = (await events()).filter((e) => e.type === 'colleague_invited');
    expect(invited).toHaveLength(1);
    expect(invited[0]!.actor).toMatchObject({ kind: 'person', name: 'Mette' });

    // The colleague, in a fresh context: their own list, nobody else's.
    const colleague = await (await browser.newContext()).newPage();
    await colleague.goto(link);
    expect(await text(colleague.locator('h1'))).toContain(`Your list · ${caseId}`);
    const list = await text(colleague.locator('main, body'));
    expect(list).toContain('Mette');
    expect(list).not.toContain(title('frm-01-untick-the-box'));
    const html = await colleague.content();
    expect(html).not.toContain(token);
    expect(html).not.toMatch(/\/c\//);
    await colleague.context().close();

    // Withdraw: on the record, and the link is dead.
    await owner.locator('.colleague-list form[action*="/revoke/"] button').first().click();
    await owner.waitForURL(new RegExp(`/en/c/${token}`));
    const gone = await owner.request.get(link);
    expect([404, 410]).toContain(gone.status());
    expect((await events()).some((e) => e.type === 'invitation_revoked')).toBe(true);
    await owner.close();
  });

  it('upward: a summary link fits one screen, shows progress and never a grade, and is revocable', async () => {
    const owner = await browser.newPage();
    await owner.goto(`${BASE}/en/c/${token}`);
    const section = owner.locator('section.share-upward');
    expect(await text(section)).toMatch(/no summary links yet/i);
    await section.locator('input[name="audience"]').fill('The board');
    await section.locator('form[action$="/share/create"] button').click();
    await owner.waitForURL(/share=created/);
    expect(new URL(owner.url()).pathname).toBe(`/en/c/${token}`);
    const row = owner.locator('section.share-upward .share-list li').first();
    expect(await row.getAttribute('data-status')).toBe('live');
    expect(await text(row)).toContain('The board');
    const link = (await row.locator('a[data-share-link]').getAttribute('href')) ?? '';
    expect(link).toMatch(/\/en\/s\/[0-9a-f]{64}$/);
    const created = (await events()).filter((e) => e.type === 'share_created');
    expect(created).toHaveLength(1);
    expect(created[0]!.payload).toMatchObject({ kind: 'upward', audience: 'The board' });

    // The reader, on a laptop screen, in a fresh context.
    const reader = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await reader.newPage();
    const response = await page.goto(link);
    expect(response?.status()).toBe(200);
    const html = await page.content();
    expect(html).not.toContain(token);
    expect(html).not.toMatch(/\/c\//);
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    expect(height).toBeLessThanOrEqual(800);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    const body = await text(page.locator('article.upward'));
    expect(body).toContain('Summary for The board');
    expect(await text(page.locator('h1.plan-lead'))).toBe('2 of 5 done');
    expect(body).not.toMatch(/%|score|grade|\/\s?100/i);
    expect(body).toMatch(/1 Blocking · 1 Serious · 1 Advisory open/);
    expect(body).toMatch(/Last checked 1 Sept 2026/);
    expect(await page.locator('.roles .role').count()).toBe(4);
    const fixed = page.locator('[data-fixed] li');
    expect(await fixed.count()).toBe(2);
    expect(await text(fixed.nth(0))).toContain(title('cns-02-gate-tags'));
    expect(await text(fixed.nth(1))).toContain(title('sec-03-hsts'));
    // Nothing to act on and nothing that is evidence.
    expect(await page.locator('form, button, .rem-card, pre, .btn').count()).toBe(0);
    expect(body).not.toContain(title('frm-01-untick-the-box'));
    expect(body).toMatch(/revoke this link at any time/i);
    await reader.close();

    // Revoke: on the record; the link answers nothing.
    await owner.locator('section.share-upward form[action*="/revoke"] button').first().click();
    await owner.waitForURL(/share=revoked/);
    expect(
      await owner
        .locator('section.share-upward .share-list li')
        .first()
        .getAttribute('data-status'),
    ).toBe('revoked');
    expect(await owner.locator('section.share-upward a[data-share-link]').count()).toBe(0);
    const dead = await owner.request.get(link);
    expect(dead.status()).toBe(404);
    const revoked = (await events()).filter((e) => e.type === 'share_revoked');
    expect(revoked).toHaveLength(1);
    expect(revoked[0]!.payload).toMatchObject({ shareId: created[0]!.payload.shareId });
    await owner.close();
  });

  it('outward: the public page goes up and comes down on the record; every share left a trail', async () => {
    const owner = await browser.newPage();
    await owner.goto(`${BASE}/en/c/${token}`);
    await owner.locator('section.trust-toggle form[action$="/trust/publish"] button').click();
    await owner.waitForURL(/trust=published/);
    const href = (await owner.locator('a[data-trust-link]').getAttribute('href')) ?? '';
    expect((await owner.request.get(`${BASE}${href}`)).status()).toBe(200);
    await owner.locator('section.trust-toggle form[action$="/trust/unpublish"] button').click();
    await owner.waitForURL(/trust=unpublished/);
    expect((await owner.request.get(`${BASE}${href}`)).status()).toBe(404);
    const types = new Set((await events()).map((e) => e.type));
    for (const type of [
      'colleague_invited',
      'invitation_revoked',
      'share_created',
      'share_revoked',
      'trust_published',
      'trust_unpublished',
    ]) {
      expect(types.has(type as never), type).toBe(true);
    }
    await owner.close();
  });
});
