import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CHECK_FOR_ME_JOB,
  caseAnswers,
  caseTimeline,
  createTestDatabase,
  openCase,
  seedRemedies,
  testDatabaseUrl,
  withTenant,
  type TestDatabase,
} from '@gc/db';
import { JobQueue } from '@gc/jobs';
import { loadCatalogue } from '@gc/remedies';

// One question at a time (D-10), in a real browser: the screen holds one question and
// nothing else that asks; every option is one tap; an answer lands on the timeline as
// the holder and the next screen says what it settled; "check it for me" queues a job
// for the agent and moves on; an answer can be changed, and both versions stay.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WEB = join(ROOT, 'apps', 'web');
const ARTIFACTS = join(ROOT, 'artifacts');
const PORT = 3429;
const BASE = `http://127.0.0.1:${PORT}`;
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

// One question, and nothing else on the screen that asks one.
async function expectOneQuestion(page: Page): Promise<string> {
  await page.locator('.q-text').first().waitFor({ timeout: 10_000 });
  expect(await page.locator('.q-text').count()).toBe(1);
  const headings = await page.locator('h1, h2, h3').allInnerTexts();
  expect(headings.filter((h) => h.includes('?'))).toHaveLength(1);
  return (await page.locator('.q-wrap').getAttribute('data-question')) ?? '';
}

describe.skipIf(!url)('one question at a time (D-10)', () => {
  let t: TestDatabase;
  let server: ChildProcess | undefined;
  let browser: Browser;
  let queue: JobQueue;
  let token = '';
  let tenantId = '';
  let caseId = '';

  beforeAll(async () => {
    t = await createTestDatabase(url);
    await seedRemedies(t, loadCatalogue());
    const opened = await openCase(t, {
      company: { domain: 'eksempelbutik.dk', country: 'DK', locale: 'da', sectorCode: '47.91.10' },
      jurisdiction: 'DK',
      locale: 'da',
    });
    token = opened.accessToken;
    tenantId = opened.tenantId;
    caseId = opened.caseId;
    queue = new JobQueue({ connectionString: url });
    await queue.start();

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
    mkdirSync(ARTIFACTS, { recursive: true });
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    server?.kill();
    await queue?.stop({ graceful: false });
    await t?.drop();
  });

  const events = () => withTenant(t, tenantId, (db) => caseTimeline(db, caseId));

  it('shows one question, chosen by the rules engine for the sector, with what it settles', async () => {
    const page = await browser.newPage();
    await page.goto(`${BASE}/en/c/${token}/questions`);
    // An online shop: the sector's own question comes first. It settles the children's
    // duty in both the national and the Union rule set, so two.
    expect(await expectOneQuestion(page)).toBe('q-children');
    expect(await page.locator('.q-unlock').getAttribute('data-settles')).toBe('2');
    expect(await page.locator('.q-opt').count()).toBe(2);
    expect(await page.locator('article').getAttribute('data-answered')).toBe('0');
    const total = Number(await page.locator('article').getAttribute('data-total'));
    expect(total).toBeGreaterThanOrEqual(4);
    // Nothing the sector rules out is offered: health data and cameras belong elsewhere.
    expect(await page.locator('.q-wrap').getAttribute('data-question')).not.toBe('q-cctv');
    await page.screenshot({ path: join(ARTIFACTS, 'd10-question.png'), fullPage: true });
    await page.close();
  });

  it('one tap answers it, the timeline records who, and the next screen says what it settled', async () => {
    const page = await browser.newPage();
    await page.goto(`${BASE}/en/c/${token}/questions`);
    await expectOneQuestion(page);
    await page.locator('.q-opt[data-option="no"]').click();
    await page.waitForURL(/questions\?settled=/);
    const settled = page.locator('[data-settled]');
    expect(await settled.innerText()).toContain('parent');
    expect(await page.locator('article').getAttribute('data-answered')).toBe('1');
    // The next question, and only it.
    expect(await expectOneQuestion(page)).toBe('q-ai-assistants');
    const answered = (await events()).filter((e) => e.type === 'question_answered');
    expect(answered).toHaveLength(1);
    expect(answered[0]!.actor.kind).toBe('person');
    expect(answered[0]!.payload).toMatchObject({
      questionId: 'q-children',
      answer: 'No',
      settled: 2,
    });
    const rows = await caseAnswers(t, tenantId, caseId);
    expect(rows.map((r) => [r.questionId, r.answer])).toEqual([['q-children', 'no']]);
    // The case page shows the count moving.
    await page.goto(`${BASE}/en/c/${token}`);
    const holds = page.locator('[data-questions-open]');
    expect(await holds.getAttribute('data-questions-answered')).toBe('1');
    expect(Number(await holds.getAttribute('data-questions-open'))).toBeGreaterThanOrEqual(3);
    await page.close();
  });

  it('"check it for me" queues a task for the agent and returns at once', async () => {
    const page = await browser.newPage();
    await page.goto(`${BASE}/en/c/${token}/questions`);
    expect(await expectOneQuestion(page)).toBe('q-ai-assistants');
    await page.locator('.q-opt[data-option="unsure"]').click();
    await page.waitForURL(/\/questions$/);
    expect(await expectOneQuestion(page)).toBe('q-cookies');
    const check = page.locator('.q-opt.check');
    expect(await check.getAttribute('data-option')).toBe('check');
    await check.click();
    await page.waitForURL(/questions\?checking=/);
    const jobId = await page.locator('[data-check-job]').getAttribute('data-check-job');
    expect(jobId).toBeTruthy();
    const job = await queue.status(CHECK_FOR_ME_JOB, jobId!);
    expect(job?.payload).toMatchObject({
      type: 'research',
      payload: { jurisdiction: 'DK', question: expect.stringContaining('cookies') },
    });
    const requested = (await events()).filter((e) => e.type === 'check_requested');
    expect(requested).toHaveLength(1);
    expect(requested[0]!.payload).toMatchObject({ questionId: 'q-cookies', jobId });
    // The flow moved on: the next question, not the parked one.
    expect(await expectOneQuestion(page)).toBe('q-headcount');
    await page.close();
  });

  it('after the last question the screen asks nothing and counts what the answers settled', async () => {
    const page = await browser.newPage();
    await page.goto(`${BASE}/en/c/${token}/questions`);
    expect(await expectOneQuestion(page)).toBe('q-headcount');
    await page.locator('.q-opt[data-option="10-49"]').click();
    await page.waitForURL(/questions\?settled=/);
    await page.locator('[data-done]').waitFor({ timeout: 10_000 });
    expect(await page.locator('.q-text').count()).toBe(0);
    expect(
      Number(await page.locator('[data-duties-settled]').getAttribute('data-duties-settled')),
    ).toBe(3);
    expect(await page.locator('[data-answered-question]').count()).toBe(4);
    await page.screenshot({ path: join(ARTIFACTS, 'd10-done.png'), fullPage: true });
    await page.close();
  });

  it('an answer can be changed, and both versions stay on the record', async () => {
    const page = await browser.newPage();
    await page.goto(`${BASE}/en/c/${token}/questions`);
    await page.locator('[data-revisit="q-children"]').click();
    await page.waitForURL(/revisit=q-children/);
    expect(await expectOneQuestion(page)).toBe('q-children');
    expect(await page.locator('.q-wrap').getAttribute('data-current')).toBe('no');
    expect(await page.locator('.q-opt[data-option="no"]').getAttribute('aria-pressed')).toBe(
      'true',
    );
    await page.locator('.q-opt[data-option="yes"]').click();
    await page.waitForURL(/questions\?settled=/);
    const rows = await caseAnswers(t, tenantId, caseId);
    expect(rows.find((r) => r.questionId === 'q-children')?.answer).toBe('yes');
    const versions = (await events()).filter(
      (e) => e.type === 'question_answered' && e.payload.questionId === 'q-children',
    );
    expect(versions.map((e) => e.payload.answer)).toEqual(['No', 'Yes']);
    expect(versions.every((e) => e.actor.kind === 'person')).toBe(true);
    // The answer taken: the duty now applies, and the screen asks nothing more.
    await page.locator('[data-done]').waitFor({ timeout: 10_000 });
    await page.close();
  });
});
