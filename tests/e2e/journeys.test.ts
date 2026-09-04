import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  RECHECK_JOB,
  caseByToken,
  CONTACT_QUESTIONS,
  caseTimeline,
  claimByOverride,
  createTestDatabase,
  findingsForCase,
  generateArtefact,
  recordAnswer,
  seedRemedies,
  testDatabaseUrl,
  withTenant,
  type TestDatabase,
} from '@gc/db';
import { JobQueue } from '@gc/jobs';
import { loadCatalogue } from '@gc/remedies';
import { BrowserPool, FixtureServer, loadFixtureSites, type FixtureHost } from '@gc/scanner';
import { registerDeepScanWorker, registerRecheckWorker, registerScanWorker } from '@gc/worker';

// The journeys (T-09): the paths a person actually takes, in a real browser, against the
// fixture estate, with the workers in this process. A fix is applied the way a fix
// happens: the site's responses change, and the re-check sees it. Nothing is seeded that
// the scan would not have written itself, except the document draft in journey three,
// because the generators (G-02) are not built yet.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WEB = join(ROOT, 'apps', 'web');
const ARTIFACTS = join(ROOT, 'artifacts');
const PORT = 3427;
const BASE = `http://127.0.0.1:${PORT}`;
const next = join(WEB, 'node_modules', 'next', 'dist', 'bin', 'next');
const url = testDatabaseUrl();

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
// Reload until the page says what we wait for, or give up.
async function untilOnReload(page: Page, check: () => Promise<boolean>, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 1500));
    await page.reload();
  }
  throw new Error('gave up waiting');
}

describe.skipIf(!url)('the journeys (T-09)', () => {
  let t: TestDatabase;
  let server: ChildProcess | undefined;
  let browser: Browser;
  let fixtures: FixtureServer;
  let pool: BrowserPool;
  let queue: JobQueue;
  // The site under repair: its headers and routes are ours to change mid-journey.
  const liveHeaders: Record<string, string> = {};
  let liveRoutes: FixtureHost['routes'][number][] = [];
  let caseUrl = '';
  let token = '';
  let caseId = '';
  let tenantId = '';
  let inviteLink = '';

  beforeAll(async () => {
    t = await createTestDatabase(url);
    const catalogue = loadCatalogue();
    await seedRemedies(t, catalogue);
    const sites = loadFixtureSites();
    const hosts = sites
      .flatMap((s) => s.hosts)
      .map((h): FixtureHost => {
        if (h.host !== 'usikker.test') return h;
        liveRoutes = [...h.routes];
        return { ...h, headers: liveHeaders, routes: liveRoutes };
      });
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
    await registerDeepScanWorker(queue, t, { pool, catalogue, agreements: 6, subProcessors: {} });

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
    if (process.env['GC_E2E_LOG'] === '1') {
      server.stdout?.on('data', (d) => process.stdout.write(String(d)));
      server.stderr?.on('data', (d) => process.stderr.write(String(d)));
    }
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

  it('scan → case opens → read a finding → apply a fix → re-check → watch it close', async () => {
    const page = await browser.newPage();
    await page.goto(`${BASE}/en`);
    await page.fill('input[name="domain"]', 'usikker.test');
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/en\/scan\/[^/]+$/, { timeout: 20_000 });
    await page.locator('.scan-steps[data-done]').waitFor({ timeout: 120_000 });
    await page.locator('.scan-out a.btn').click();
    await page.waitForURL(/\/en\/c\/[a-f0-9]{64}$/, { timeout: 20_000 });
    caseUrl = page.url();
    token = caseUrl.split('/').pop()!;
    const found = await caseByToken(t, token);
    expect(found).toBeDefined();
    caseId = found!.caseId;
    tenantId = found!.tenantId;

    // The case opened with the site's real problems, the missing transport header among them.
    const step = page.locator('li.step[data-type="SEC-03"]');
    expect(await step.count()).toBe(1);
    expect(await step.getAttribute('data-status')).toBe('open');
    // Read it: the evidence the scanner kept, and the fix as a prompt to paste.
    const evidence = await text(step.locator('details.evidence'));
    expect(evidence).toMatch(/usikker\.test/);
    expect(evidence.length).toBeGreaterThan(40);
    const prompt = await text(step.locator('.act-b pre.act-t'));
    expect(prompt).toContain('usikker.test');
    expect(prompt).toMatch(/strict-transport-security/i);

    // Apply the fix: the site starts sending the header the prompt asked for.
    liveHeaders['strict-transport-security'] = 'max-age=63072000; includeSubDomains';

    // Re-check, and watch it close.
    await step.locator('form.step-act button').click();
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
    expect(await text(page.locator('li.step[data-type="SEC-03"] .sev'))).toMatch(/fixed/i);
    const events = await withTenant(t, tenantId, (db) => caseTimeline(db, caseId));
    expect(events.some((e) => e.type === 'scan_started' && e.payload.kind === 'recheck')).toBe(
      true,
    );
    expect(events.some((e) => e.type === 'finding_closed')).toBe(true);
    const rows = await findingsForCase(t, tenantId, caseId);
    const hsts = rows.filter((r) => r.typeId === 'SEC-03');
    expect(hsts.map((r) => r.status)).toEqual(['closed']);
    expect(rows.filter((r) => r.typeId.startsWith('SEC-')).length).toBe(7);
    await page.close();
  }, 300_000);

  it('invite a colleague → they finish an item on their list → progress updates for everyone', async () => {
    const owner = await browser.newPage();
    await owner.goto(caseUrl);
    await owner.fill('form.invite input[name="from"]', 'Mette');
    await owner.fill('form.invite input[name="email"]', 'lars@usikker.test');
    await owner.selectOption('form.invite select[name="role"]', 'it');
    await owner.locator('form.invite button[type=submit]').click();
    await owner.waitForURL(new RegExp(`/en/c/${token}`));
    inviteLink = (await owner.locator('a[data-invite-link]').first().getAttribute('href')) ?? '';
    expect(inviteLink).toMatch(/\/en\/m\//);
    const doneBefore = Number(
      (await text(owner.locator('section.progress p'))).match(/(\d+)\/\d+/)?.[1] ?? '0',
    );

    // Lars opens his list: the site's worst transport problem is at the top of IT's desk.
    const lars = await (await browser.newContext()).newPage();
    await lars.goto(inviteLink);
    const item = lars.locator('li[data-finding]').first();
    const findingId = (await item.getAttribute('data-finding')) ?? '';
    expect(findingId).not.toBe('');
    const rows = await findingsForCase(t, tenantId, caseId);
    const typeId = rows.find((r) => r.id === findingId)?.typeId;
    expect(typeId).toBe('SEC-01');

    // He applies the fix: the site now sends plain-http visitors to https.
    liveRoutes.unshift({
      path: '/',
      scheme: 'http',
      status: 301,
      headers: { location: 'https://usikker.test/' },
    });
    await item.locator('form button').click();
    await lars.waitForURL(/checked=1/);
    // His list catches up as the re-check lands: the item is done, in his own name.
    const itDone = async (page: Page) =>
      Number(
        (await text(page.locator('section.progress li[data-role="it"]'))).match(/(\d+)/)?.[1] ??
          '0',
      );
    const larsDoneBefore = await itDone(lars);
    try {
      await untilOnReload(
        lars,
        async () => (await lars.locator(`li[data-finding="${findingId}"]`).count()) === 0,
        120_000,
      );
    } catch (e) {
      const dead = await queue.deadLetters(RECHECK_JOB);
      const tl = await withTenant(t, tenantId, (db) => caseTimeline(db, caseId));
      console.error('recheck dead letters', JSON.stringify(dead.map((d) => d.reason)));
      console.error(
        'timeline tail',
        JSON.stringify(tl.slice(-8).map((x) => [x.type, x.payload, x.actor.kind])),
      );
      throw e;
    }
    expect(await itDone(lars)).toBeGreaterThan(larsDoneBefore);
    const events = await withTenant(t, tenantId, (db) => caseTimeline(db, caseId));
    const closed = events.filter(
      (e) => e.type === 'finding_closed' && e.payload.findingId === findingId,
    );
    expect(closed).toHaveLength(1);
    const started = events.filter((e) => e.type === 'scan_started' && e.actor.kind === 'person');
    expect(started.length).toBeGreaterThanOrEqual(2);

    // The owner sees the progress, without being told which finding it was by whom.
    await owner.reload();
    const doneAfter = Number(
      (await text(owner.locator('section.progress p'))).match(/(\d+)\/\d+/)?.[1] ?? '0',
    );
    expect(doneAfter).toBeGreaterThan(doneBefore);
    expect(await text(owner.locator('.colleague-list'))).toContain('lars@usikker.test');
    // The register filled from the scan (G-01): rows the company confirms one by one,
    // answering how long the data is kept as it does; the case page counts them.
    const before = await text(owner.locator('li[data-register-confirmed]'));
    expect(before).toMatch(/^0\/[1-9]/);
    await owner.goto(`${caseUrl}/register`);
    const drafts = owner.locator('li[data-key][data-status="draft"]');
    expect(await drafts.count()).toBeGreaterThan(0);
    const key = (await drafts.first().getAttribute('data-key')) ?? '';
    await drafts.first().locator('input[name="retention"]').fill('12 måneder efter henvendelsen');
    await drafts.first().locator('button[type=submit]').click();
    await owner.waitForURL(/register\?confirmed=1/);
    const row = owner.locator(`li[data-key="${key}"]`);
    expect(await row.getAttribute('data-status')).toBe('confirmed');
    expect(await text(row.locator('dd[data-retention]'))).toContain('12 måneder');
    const record = await owner.request.get(`${caseUrl}/register.md`);
    expect(record.status()).toBe(200);
    expect(await record.text()).toContain('12 måneder efter henvendelsen');
    await owner.goto(caseUrl);
    expect(await text(owner.locator('li[data-register-confirmed]'))).toMatch(/^1\//);
    await lars.context().close();
    await owner.close();
  }, 300_000);

  it('a document is generated, read and signed off', async () => {
    // The generators (G-02) are not built: the draft is placed the way they will place
    // it, and the sign-off is the real one.
    await generateArtefact(t, tenantId, {
      caseId,
      kind: 'privacy_policy',
      locale: 'en',
      content:
        'Privacy policy for usikker.test\n\nWe process your name and address to deliver what you ordered.\n\nYou can complain to Datatilsynet.',
      by: { kind: 'agent', name: 'drafter' },
    });
    const page = await browser.newPage();
    await page.goto(`${caseUrl}/artefacts/privacy_policy`);
    const doc = page.locator('article.artefact');
    expect(await doc.getAttribute('data-status')).toBe('draft');
    expect(await text(doc.locator('.doc-body'))).toContain('Datatilsynet');
    await doc.locator('form[action$="/sign"] input[name=name]').fill('Mette Sørensen');
    await doc.locator('form[action$="/sign"] button').click();
    await page.waitForURL(/outcome=signed/);
    expect(await doc.getAttribute('data-status')).toBe('signed');
    expect(await text(doc.locator('[data-signed]'))).toContain('Mette Sørensen');
    const events = await withTenant(t, tenantId, (db) => caseTimeline(db, caseId));
    expect(events.some((e) => e.type === 'artefact_signed')).toBe(true);
    await page.close();
  });

  it('deep scan → answer three questions → new findings appear → generate an artefact → sign it off', async () => {
    const page = await browser.newPage();
    // A site that talks to suppliers of its own.
    await page.goto(`${BASE}/en`);
    await page.fill('input[name="domain"]', 'eksempelbutik.test');
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/en\/scan\/[^/]+$/, { timeout: 20_000 });
    await page.locator('.scan-steps[data-done]').waitFor({ timeout: 120_000 });
    await page.locator('.scan-out a.btn').click();
    await page.waitForURL(/\/en\/c\/[a-f0-9]{64}$/, { timeout: 20_000 });
    const url3 = page.url();
    const token3 = url3.split('/').pop()!;
    const found = (await caseByToken(t, token3))!;
    const before = await findingsForCase(t, found.tenantId, found.caseId);
    expect(before.length).toBeGreaterThan(0);

    // Unclaimed, the deeper look is not offered; asked for anyway, it is refused.
    expect(await page.locator('form[data-deep-scan-form]').count()).toBe(0);
    const refused = await fetch(`${url3}/deep-scan`, { method: 'POST', redirect: 'manual' });
    expect(refused.status).toBe(303);
    expect(refused.headers.get('location')).toContain('outcome=unclaimed');

    // The owner proves control (C-01, the override route), and looks deeper.
    await claimByOverride(t, {
      caseId: found.caseId,
      tenantId: found.tenantId,
      by: 'Frits',
      reason: 'the owner proved control by phone, for the journey',
    });
    await page.reload();
    await page.locator('form[data-deep-scan-form] button').click();
    await page.waitForURL(/deep=/);
    await untilOnReload(
      page,
      async () => (await page.locator('[data-deep-scan]').getAttribute('data-outcome')) === 'done',
      180_000,
    );
    const status = page.locator('[data-deep-scan]');
    expect(Number(await status.getAttribute('data-findings'))).toBeGreaterThan(0);
    expect(await page.locator('[data-deep-plan] li').count()).toBeGreaterThan(0);
    // New findings: the suppliers that publish no processing agreement.
    expect(await page.locator('li.step[data-type="DPA-01"]').count()).toBeGreaterThan(0);
    const after = await findingsForCase(t, found.tenantId, found.caseId);
    expect(after.length).toBeGreaterThan(before.length);
    expect(after.filter((f) => !f.typeId.startsWith('DPA-')).map((f) => f.status)).toEqual(
      before.map((f) => f.status),
    );
    const events3 = await withTenant(t, found.tenantId, (db) => caseTimeline(db, found.caseId));
    expect(events3.some((e) => e.type === 'scan_started' && e.payload.kind === 'deep')).toBe(true);
    expect(
      events3.some(
        (e) => e.type === 'note_added' && String(e.payload.text).startsWith('Deep scan planned'),
      ),
    ).toBe(true);

    // Three questions, one at a time, each settling what it settles.
    for (let i = 0; i < 3; i += 1) {
      await page.goto(`${url3}/questions`);
      await page.locator('.q-opt').first().waitFor({ timeout: 10_000 });
      await page.locator('.q-opt').first().click();
      await page.waitForURL(/questions\?settled=/);
    }
    expect(await page.locator('article').getAttribute('data-answered')).toBe('3');

    // The register, confirmed row by row with how long each is kept (G-01), and the
    // company's contact details, which arrive the way the drafter expects them.
    await page.goto(`${url3}/register`);
    for (let i = 0; i < 12; i += 1) {
      const drafts = page.locator('li[data-key][data-status="draft"]');
      if ((await drafts.count()) === 0) break;
      await drafts.first().locator('input[name="retention"]').fill('12 måneder efter henvendelsen');
      await drafts.first().locator('button[type=submit]').click();
      await page.waitForURL(/register\?confirmed=1/);
    }
    expect(await page.locator('li[data-key][data-status="draft"]').count()).toBe(0);
    for (const [questionId, answer] of [
      [CONTACT_QUESTIONS.address, 'Eksempelvej 1, 8000 Aarhus C'],
      [CONTACT_QUESTIONS.email, 'privatliv@eksempelbutik.test'],
    ] as const) {
      await recordAnswer(t, found.tenantId, {
        caseId: found.caseId,
        questionId,
        answer,
        by: { kind: 'person', userId: 'owner', name: 'Mette' },
        at: new Date(),
      });
    }

    // The privacy policy, generated from the page (G-02) and signed off (A-09).
    await page.goto(`${url3}/artefacts/privacy_policy`);
    const gaps = await page.locator('[data-gap]').allInnerTexts();
    expect(gaps, 'the policy can be written').toEqual([]);
    await page.locator('form[data-generate] button').click();
    await page.waitForURL(/outcome=/);
    const doc = page.locator('article.artefact');
    expect(await doc.getAttribute('data-status')).toBe('draft');
    await doc.locator('form[action$="/sign"] input[name=name]').fill('Mette Sørensen');
    await doc.locator('form[action$="/sign"] button').click();
    await page.waitForURL(/outcome=signed/);
    expect(await doc.getAttribute('data-status')).toBe('signed');
    const signed = await withTenant(t, found.tenantId, (db) => caseTimeline(db, found.caseId));
    expect(signed.filter((e) => e.type === 'artefact_signed').length).toBeGreaterThan(0);
    await page.close();
  }, 600_000);

  it('export the case, then delete it, and it is gone', async () => {
    const page = await browser.newPage();
    const exported = await page.request.get(`${caseUrl}/export.json`);
    expect(exported.status()).toBe(200);
    const bundle = (await exported.json()) as { case?: { id?: string }; caseId?: string };
    expect(JSON.stringify(bundle)).toContain(caseId);
    const report = await page.request.get(`${caseUrl}/report.pdf`);
    expect(report.status()).toBe(200);

    await page.goto(caseUrl);
    await page.fill('form[action$="/delete"] input[name="confirm"]', caseId);
    await page.locator('form[action$="/delete"] button').click();
    await page.waitForURL(/\/en\/deleted\?audit=/, { timeout: 20_000 });
    expect(await page.locator('body').innerText()).not.toContain(token);

    // Gone: the case, its export, its report, the colleague's link, the database row.
    for (const target of [caseUrl, `${caseUrl}/export.json`, `${caseUrl}/report.pdf`, inviteLink]) {
      const r = await page.request.get(target);
      expect(r.status(), target).toBe(404);
    }
    expect(await caseByToken(t, token)).toBeUndefined();
    await page.close();
  });
});
