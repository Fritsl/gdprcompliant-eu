import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256, type Evidence } from '@gc/contracts';
import {
  createTestDatabase,
  generateArtefact,
  openCase,
  schema,
  seedRemedies,
  storeEvidence,
  storeFindings,
  testDatabaseUrl,
  withTenant,
  type TestDatabase,
} from '@gc/db';
import { bindingFor, raiseFindings } from '@gc/findings';
import { JobQueue } from '@gc/jobs';
import { loadCatalogue } from '@gc/remedies';
import { BrowserPool, FixtureServer, loadFixtureSites } from '@gc/scanner';
import { registerRecheckWorker } from '@gc/worker';

// Remedy interactions (U-04), in a real browser with the re-check worker running against
// the fixture estate: a self-fix shows the exact change and its re-check says what the
// scanner saw, both ways; a generated document is read and signed before it can be
// published or leave; our own product is labelled as ours; and no control leaves the case.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WEB = join(ROOT, 'apps', 'web');
const ARTIFACTS = join(ROOT, 'artifacts');
const PORT = 3424;
const BASE = `http://127.0.0.1:${PORT}`;
const next = join(WEB, 'node_modules', 'next', 'dist', 'bin', 'next');
const url = testDatabaseUrl();
const T0 = new Date('2026-09-04T10:00:00Z');

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

function row(ctx: { tenantId: string; caseId: string }, host: string, body: string): Evidence {
  const hash = sha256(body);
  return {
    id: `header:${hash.slice(0, 16)}`,
    tenantId: ctx.tenantId,
    caseId: ctx.caseId,
    scanId: 'scan-u04',
    kind: 'header',
    capturedAt: T0.toISOString(),
    source: { url: `https://${host}/`, host, pass: 'A' },
    body,
    hash,
    caption: 'Response headers of the home page',
  };
}

// The controls a page offers, and where each one goes.
async function controls(page: Page) {
  return page.evaluate(() => {
    const links = [...document.querySelectorAll<HTMLAnchorElement>('.case a[href]')].map((a) => ({
      href: a.getAttribute('href') ?? '',
      target: a.getAttribute('target') ?? '',
      rel: a.getAttribute('rel') ?? '',
    }));
    const forms = [...document.querySelectorAll<HTMLFormElement>('.case form')].map(
      (f) => f.getAttribute('action') ?? '',
    );
    return { links, forms };
  });
}

describe.skipIf(!url)('remedy interactions (U-04)', () => {
  let t: TestDatabase;
  let server: ChildProcess | undefined;
  let browser: Browser;
  let fixtures: FixtureServer;
  let pool: BrowserPool;
  let queue: JobQueue;
  // Case A on usikker.test: no HSTS, and it stays that way.
  let tokenA = '';
  let tenantA = '';
  let hstsA = '';
  // Case B on brochure.test: a finding seeded as if HSTS were missing; the site has it.
  let tokenB = '';
  let hstsB = '';

  beforeAll(async () => {
    t = await createTestDatabase(url);
    const catalogue = loadCatalogue();
    await seedRemedies(t, catalogue);
    const sites = loadFixtureSites();
    fixtures = await new FixtureServer(sites.flatMap((s) => s.hosts)).start();
    pool = await new BrowserPool({
      concurrency: 2,
      passTimeoutMs: 60_000,
      navigationTimeoutMs: 10_000,
      launch: { proxy: { server: fixtures.proxy } },
      ignoreHTTPSErrors: true,
    }).start();
    queue = new JobQueue({ connectionString: url, pollingIntervalSeconds: 1 });
    await queue.start();
    await registerRecheckWorker(queue, t, {
      pool,
      catalogue,
      quiet: { minDwellMs: 800, quietMs: 400, maxWaitMs: 8_000 },
    });

    for (const [host, which] of [
      ['usikker.test', 'A'],
      ['brochure.test', 'B'],
    ] as const) {
      const opened = await openCase(t, {
        company: { domain: host, country: 'DK', locale: 'da' },
        jurisdiction: 'DK',
        locale: 'da',
      });
      const ctx = { tenantId: opened.tenantId, caseId: opened.caseId };
      const hsts = row(
        ctx,
        host,
        `HTTP/1.1 200 OK\r\n(no strict-transport-security header on ${host})`,
      );
      await storeEvidence(t, ctx.tenantId, [hsts]);
      const findings = raiseFindings(
        [
          {
            typeId: 'SEC-03',
            // The scanner's own subject, so a re-check meets the same fingerprint.
            subject: { host },
            evidence: [
              { evidenceId: hsts.id, hash: hsts.hash, quote: 'strict-transport-security' },
            ],
          },
          ...(which === 'A'
            ? [{ typeId: 'POL-01' as const, evidence: [{ evidenceId: hsts.id, hash: hsts.hash }] }]
            : []),
        ],
        { ...ctx, jurisdiction: 'DK', catalogue, scanId: 'scan-u04', now: () => T0 },
      );
      await storeFindings(t, ctx.tenantId, findings);
      const hstsId = findings.find((f) => f.typeId === 'SEC-03')!.id;
      if (which === 'A') {
        tokenA = opened.accessToken;
        tenantA = opened.tenantId;
        hstsA = hstsId;
        // Remedies whose detectors are not registered yet: rows straight in, the way a
        // later detector will write them.
        for (const [id, type, remedy, area] of [
          ['f-ai3', 'AI-03', 'ai-03-move-to-gdprchat', 'Recipients'],
          ['f-trf1', 'TRF-01', 'trf-01-european-alternatives', 'Transfers'],
          ['f-vnd11', 'VND-11', 'vnd-11-unidentified-host', 'Recipients'],
        ] as const) {
          const entry = catalogue.get(remedy)!;
          await withTenant(t, ctx.tenantId, (db) =>
            db.insert(schema.findings).values({
              id,
              tenantId: ctx.tenantId,
              sourceRef: 'test',
              caseId: ctx.caseId,
              typeId: type,
              fingerprint: `${type}|x`,
              jurisdiction: 'DK',
              binding: bindingFor(type, 'DK'),
              severity: 'serious',
              status: 'open',
              area,
              remedyId: remedy,
              remedyVersion: entry.remedy.version,
              firstSeenAt: T0,
              lastSeenAt: T0,
            }),
          );
        }
        await generateArtefact(t, ctx.tenantId, {
          caseId: ctx.caseId,
          kind: 'privacy_policy',
          locale: 'da',
          content:
            'Privatlivspolitik for usikker.test\n\nVi behandler navn, adresse og ordrehistorik for at levere det, du har bestilt.\n\nDu kan klage til Datatilsynet.',
          by: { kind: 'agent', name: 'drafter', model: 'test' },
          now: T0,
        });
      } else {
        tokenB = opened.accessToken;
        hstsB = hstsId;
      }
    }

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

  it('a self-fix shows the exact change as a prompt to paste, the code behind it, and copies in one click', async () => {
    const context = await browser.newContext();
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
    const page = await context.newPage();
    await page.goto(`${BASE}/en/c/${tokenA}`);
    const step = page.locator(`li.step[data-type="SEC-03"]`);
    expect(await step.locator('.rem-card').getAttribute('data-remedy')).toBe('self_fix');
    expect(await text(step.locator('.tag'))).toMatch(/free fix/i);
    const prompt = await text(step.locator('.act-b[data-action="agent_prompt"] pre.act-t'));
    expect(prompt.length).toBeGreaterThan(80);
    expect(prompt).toContain('usikker.test');
    expect(prompt).not.toMatch(/\{\{domain\}\}/);
    // The code is there too, behind a drawer, and it is the catalogue's snippet.
    const code = step.locator('details.code-alt');
    expect(await code.count()).toBe(1);
    await code.locator('summary').click();
    const snippet = await text(code.locator('pre[data-snippet]'));
    expect(snippet).toMatch(/strict-transport-security/i);
    // Copy, and the button says so; the clipboard holds the prompt.
    const copy = step.locator('button.act-c');
    await copy.click();
    await expect.poll(() => copy.getAttribute('data-copy')).toBe('done');
    expect(await text(copy)).toBe('Copied');
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    const flat = (x: string) => x.replace(/\s+/g, ' ').trim();
    expect(flat(clip)).toBe(flat(prompt));
    await context.close();
  });

  it('the re-check reports what the scanner saw: still open on the site without the header, fixed on the site with it', async () => {
    const page = await browser.newPage();
    // Case A: usikker.test has no HSTS, so the honest answer is "still open".
    await page.goto(`${BASE}/en/c/${tokenA}`);
    const stepA = page.locator(`li.step[data-finding="${hstsA}"]`);
    await stepA.locator('form.step-act button').click();
    await page.waitForURL(/recheck=/);
    expect(new URL(page.url()).pathname).toBe(`/en/c/${tokenA}`);
    const reportA = page.locator(`li.step[data-finding="${hstsA}"] [role=status]`);
    await expect
      .poll(() => reportA.getAttribute('data-recheck'), { timeout: 90_000 })
      .not.toBe('running');
    expect(await reportA.getAttribute('data-recheck')).toBe('open');
    expect(await text(reportA)).toMatch(/still open/i);
    expect(await page.locator(`li.step[data-finding="${hstsA}"]`).getAttribute('data-status')).toBe(
      'open',
    );

    // Case B: brochure.test sends the header, so the finding closes, and the page says so.
    await page.goto(`${BASE}/en/c/${tokenB}`);
    expect(await text(page.locator('h1.plan-lead'))).toBe('1 fix ready');
    await page.locator(`li.step[data-finding="${hstsB}"] form.step-act button`).click();
    await page.waitForURL(/recheck=/);
    const reportB = page.locator(`li.step[data-finding="${hstsB}"] [role=status]`);
    await expect
      .poll(() => reportB.getAttribute('data-recheck'), { timeout: 90_000 })
      .not.toBe('running');
    expect(await reportB.getAttribute('data-recheck')).toBe('closed');
    // The page re-rendered in place: the badge and the lead follow, the URL did not move.
    await expect
      .poll(() => page.locator(`li.step[data-finding="${hstsB}"]`).getAttribute('data-status'), {
        timeout: 15_000,
      })
      .toBe('closed');
    expect(await text(page.locator(`li.step[data-finding="${hstsB}"] .sev`))).toMatch(/fixed/i);
    expect(await text(page.locator(`li.step[data-finding="${hstsB}"] .verified`))).toMatch(
      /re-checked/i,
    );
    expect(await text(page.locator('h1.plan-lead'))).toBe('Nothing left to fix');
    expect(new URL(page.url()).pathname).toBe(`/en/c/${tokenB}`);
    await page.close();
  }, 200_000);

  it('a generated document is read and signed before it can be published or leave', async () => {
    const page = await browser.newPage();
    await page.goto(`${BASE}/en/c/${tokenA}`);
    const step = page.locator('li.step[data-type="POL-01"]');
    expect(await step.locator('.rem-card').getAttribute('data-remedy')).toBe('generated_artefact');
    const cta = step.locator('.rem-acts a.btn, .rem-acts a.btn-2').first();
    expect(await text(cta)).toMatch(/preview the draft/i);
    await cta.click();
    await page.waitForURL(/\/artefacts\/privacy_policy$/);
    expect(new URL(page.url()).pathname).toBe(`/en/c/${tokenA}/artefacts/privacy_policy`);
    const doc = page.locator('article.artefact');
    expect(await doc.getAttribute('data-status')).toBe('draft');
    expect(await text(doc.locator('.eyebrow'))).toMatch(/preview before anything is published/i);
    expect(await text(doc.locator('.doc-body'))).toContain('Datatilsynet');
    // Nothing to publish or download yet.
    expect(await doc.locator('form[action$="/publish"]').count()).toBe(0);
    expect(await doc.locator('a[href$="/export"]').count()).toBe(0);
    const exportBefore = await page.request.get(
      `${BASE}/en/c/${tokenA}/artefacts/privacy_policy/export`,
    );
    expect(exportBefore.status()).toBe(404);
    // The signature binds the version and the hash shown.
    const hash = await doc.locator('form[action$="/sign"] input[name=hash]').inputValue();
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(await text(doc.locator('.doc-h .sub'))).toContain(hash.slice(0, 12));
    await doc.locator('form[action$="/sign"] input[name=name]').fill('Mette Hansen');
    await doc.locator('form[action$="/sign"] button').click();
    await page.waitForURL(/outcome=signed/);
    expect(await doc.getAttribute('data-status')).toBe('signed');
    expect(await text(doc.locator('.doc-h [data-signed]'))).toContain('Mette Hansen');
    // Now it can be published and downloaded, and the download carries the signature.
    expect(await doc.locator('form[action$="/publish"]').count()).toBe(1);
    const exported = await page.request.get(
      `${BASE}/en/c/${tokenA}/artefacts/privacy_policy/export`,
    );
    expect(exported.status()).toBe(200);
    expect(exported.headers()['x-artefact-hash']).toBe(hash);
    expect(decodeURIComponent(exported.headers()['x-artefact-signed-by'] ?? '')).toBe(
      'Mette Hansen',
    );
    expect(await exported.text()).toContain('Datatilsynet');
    await doc
      .locator('form[action$="/publish"] input[name=url]')
      .fill('https://usikker.test/privatliv');
    await doc.locator('form[action$="/publish"] button').click();
    await page.waitForURL(/outcome=published/);
    expect(await doc.getAttribute('data-status')).toBe('published');
    expect(await text(doc.locator('.doc-h [data-published]'))).toContain('usikker.test/privatliv');
    // Back to the case is a link on the page, and it goes there.
    await doc.locator('a.lnk').click();
    await page.waitForURL(new RegExp(`/en/c/${tokenA}$`));
    await page.close();
  });

  it('our product is labelled as ours, in words, next to the button that leads to it', async () => {
    const page = await browser.newPage();
    await page.goto(`${BASE}/en/c/${tokenA}`);
    const step = page.locator('li.step[data-type="AI-03"]');
    expect(await step.locator('.rem-card').getAttribute('data-remedy')).toBe('our_product');
    expect(await text(step.locator('.tag'))).toMatch(/our product/i);
    expect(await text(step.locator('[data-ours]'))).toMatch(/our own product/i);
    expect(await text(step.locator('[data-ours]'))).toMatch(/earn money/i);
    const link = step.locator('a[data-product]');
    expect(await link.getAttribute('href')).toBe('https://gdprchat.eu');
    expect(await link.getAttribute('target')).toBe('_blank');
    expect(await link.getAttribute('rel')).toContain('noopener');
    expect(await text(link)).toContain('gdprchat.eu');
    // The alternatives are there in the same card.
    expect(await text(step.locator('.rem-card p.muted').last())).toMatch(/alternatives/i);
    // The message to the people using it, with copy.
    expect(await step.locator('.act-b.act-msg').count()).toBe(1);
    expect(await step.locator('.act-b.act-msg a.act-send').getAttribute('href')).toMatch(
      /^mailto:/,
    );
    await page.close();
  });

  it('nothing leaves the case without saying so: every form posts to the case, every outside link opens elsewhere and is marked', async () => {
    const page = await browser.newPage();
    await page.goto(`${BASE}/en/c/${tokenA}`);
    const { links, forms } = await controls(page);
    expect(forms.length).toBeGreaterThan(3);
    for (const action of forms) expect(action.startsWith(`/en/c/${tokenA}/`)).toBe(true);
    const outside = links.filter((l) => /^https?:\/\//.test(l.href));
    expect(outside.length).toBeGreaterThan(0);
    for (const l of outside) {
      expect(l.target).toBe('_blank');
      expect(l.rel).toContain('noopener');
    }
    // Every internal link is the case, or one of our own guide pages: nothing else.
    for (const l of links.filter(
      (l) => !/^https?:\/\//.test(l.href) && !l.href.startsWith('mailto:'),
    )) {
      expect(l.href.startsWith(`/en/c/${tokenA}`) || l.href.startsWith('/en/guides/'), l.href).toBe(
        true,
      );
    }
    // The partner alternatives and the outside links carry the mark in the text.
    const marked = await page.locator('.case a[data-external]').allInnerTexts();
    for (const m of marked) expect(m).toContain('↗');
    // "Ask for an answer" on a remedy with none: a row in the ledger, and back here.
    const ask = page.locator('li.step[data-type="VND-11"] form[action*="/ask/"] button');
    expect(await ask.count()).toBe(1);
    await ask.click();
    await page.waitForURL(/asked=1/);
    expect(new URL(page.url()).pathname).toBe(`/en/c/${tokenA}`);
    expect(await text(page.locator('[role=status]'))).toMatch(/looking for an answer/i);
    const ledger = await withTenant(t, tenantA, (db) => db.select().from(schema.demandEntries));
    expect(ledger.map((r) => [r.findingTypeId, r.answer])).toEqual([['VND-11', 'none']]);
    await page.close();
  });
});
