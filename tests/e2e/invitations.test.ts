import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256 } from '@gc/contracts';
import {
  INVITES_PER_CASE_PER_HOUR,
  SHARED_TENANT,
  caseTimeline,
  createTestDatabase,
  inviteMember,
  openCase,
  outboxFor,
  schema,
  testDatabaseUrl,
  withTenant,
  type TestDatabase,
} from '@gc/db';

// Invitations from a colleague, in a real browser (P-02): the owner invites in their
// own name from the case page; the colleague opens the link and is on their list with
// no account and no form; reminders and withdrawals work from the same page; every
// step is on the timeline; and the eleventh invitation in an hour is refused.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WEB = join(ROOT, 'apps', 'web');
const PORT = 3418;
const BASE = `http://127.0.0.1:${PORT}`;
const next = join(WEB, 'node_modules', 'next', 'dist', 'bin', 'next');

const url = (() => {
  try {
    return testDatabaseUrl();
  } catch (e) {
    if (process.env['CI']) throw e;
    console.warn((e as Error).message);
    return undefined;
  }
})();

// vitest has no Playwright matchers: wait for the element, then read what it says.
const text = async (locator: import('playwright').Locator): Promise<string> => {
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

describe.skipIf(!url)('invitations from a colleague (P-02)', () => {
  let t: TestDatabase;
  let server: ChildProcess | undefined;
  let browser: Browser;
  let token = '';
  let caseId = '';
  let tenantId = '';

  beforeAll(async () => {
    t = await createTestDatabase(url);
    const opened = await openCase(t, {
      company: { domain: 'eksempelbutik.dk', country: 'DK', locale: 'da' },
      jurisdiction: 'DK',
      locale: 'da',
    });
    caseId = opened.caseId;
    tenantId = opened.tenantId;
    token = opened.accessToken;
    await t.db.insert(schema.remedies).values({
      id: 'sec-03-hsts',
      version: 1,
      tenantId: SHARED_TENANT,
      sourceRef: 'catalogue',
      findingTypeId: 'SEC-03',
      kind: 'self_fix',
      jurisdictions: 'all',
      content: {},
      hash: sha256('sec-03'),
    });
    await withTenant(t, tenantId, (db) =>
      db.insert(schema.findings).values({
        id: 'f-sec',
        tenantId,
        sourceRef: 'test',
        caseId,
        typeId: 'SEC-03',
        fingerprint: 'SEC-03|x',
        jurisdiction: 'DK',
        binding: {},
        severity: 'serious',
        area: 'Security',
        remedyId: 'sec-03-hsts',
        remedyVersion: 1,
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
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
    if (process.env['GC_E2E_LOG'] === '1') {
      server.stderr?.on('data', (d) => process.stderr.write(String(d)));
      server.stdout?.on('data', (d) => process.stderr.write(String(d)));
    }
    await waitFor(`${BASE}/en`, 60_000);
    browser = await chromium.launch();
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    server?.kill();
    await t?.drop();
  });

  it('the owner invites in their own name; the colleague opens the link and is on their list, no account asked', async () => {
    const owner = await browser.newPage();
    await owner.goto(`${BASE}/en/c/${token}`);
    expect(await text(owner.locator('.colleagues'))).toContain('Nobody has been invited yet.');
    await owner.fill('form.invite input[name="from"]', 'Mette');
    await owner.fill('form.invite input[name="email"]', 'lars@eksempelbutik.dk');
    await owner.selectOption('form.invite select[name="role"]', 'it');
    await owner.click('form.invite button[type="submit"]');
    await owner.waitForURL(new RegExp(`/en/c/${token}$`));
    const row = owner.locator('.colleague-list li[data-role="it"]');
    expect(await text(row)).toContain('lars@eksempelbutik.dk');
    expect(await text(row)).toContain('invited, not yet opened');
    expect(await text(row)).toContain('1 open');
    const link = await row.locator('a[data-invite-link]').getAttribute('href');
    expect(link).toMatch(new RegExp(`^${BASE}/en/m/[0-9a-f]{64}$`));

    const mail = await outboxFor(t, tenantId, caseId);
    expect(mail.map((m) => [m.kind, m.to])).toEqual([['invitation', 'lars@eksempelbutik.dk']]);
    expect(mail[0]?.body).toContain('Mette');

    // A fresh browser context: no cookies, no session, nothing but the link.
    const colleague = await (await browser.newContext()).newPage();
    const response = await colleague.goto(link!);
    expect(response?.status()).toBe(200);
    expect(await text(colleague.locator('h1'))).toContain(`Your list · ${caseId}`);
    expect(await text(colleague.locator('article.member'))).toContain('Invited by Mette');
    expect(await text(colleague.locator('.role-list li[data-finding="f-sec"]'))).toContain(
      'Tell browsers to stay on HTTPS',
    );
    expect(
      await colleague
        .locator('input[type="password"], input[name*="signup"], form[action*="register"]')
        .count(),
    ).toBe(0);
    // Nothing of the rest of the case, and nothing that only the owner sees.
    expect(await colleague.content()).not.toContain('Delete this case');
    expect(await colleague.content()).not.toContain('/export.json');

    await owner.reload();
    expect(await text(owner.locator('.colleague-list li[data-role="it"]'))).toContain('working');

    const events = await withTenant(t, tenantId, (db) => caseTimeline(db, caseId));
    expect(events.map((e) => e.type)).toEqual([
      'case_opened',
      'colleague_invited',
      'colleague_joined',
    ]);
    await colleague.close();
    await owner.close();
  });

  it('remind works once a day, withdraw kills the link, and both are on the timeline', async () => {
    const owner = await browser.newPage();
    await owner.goto(`${BASE}/en/c/${token}`);
    const row = owner.locator('.colleague-list li[data-role="it"]');
    const link = await row.locator('a[data-invite-link]').getAttribute('href');

    await row.locator('form[action*="/remind/"] button').click();
    await owner.waitForURL(new RegExp(`/en/c/${token}$`));
    expect((await outboxFor(t, tenantId, caseId)).map((m) => m.kind)).toEqual([
      'invitation',
      'reminder',
    ]);
    await row.locator('form[action*="/remind/"] button').click();
    await owner.waitForURL(/outcome=reminded/);
    expect(await text(owner.locator('[role="alert"]'))).toContain('less than a day ago');

    await owner
      .locator('.colleague-list li[data-role="it"] form[action*="/revoke/"] button')
      .click();
    await owner.waitForURL(new RegExp(`/en/c/${token}$`));
    expect(await text(owner.locator('.colleague-list li[data-role="it"]'))).toContain('withdrawn');
    expect(
      await owner.locator('.colleague-list li[data-role="it"] a[data-invite-link]').count(),
    ).toBe(0);
    const dead = await fetch(link!);
    expect(dead.status).toBe(404);

    const events = await withTenant(t, tenantId, (db) => caseTimeline(db, caseId));
    expect(events.slice(-2).map((e) => e.type)).toEqual(['reminder_sent', 'invitation_revoked']);
    await owner.close();
  });

  it('the eleventh invitation in an hour is refused on the page', async () => {
    const sent = (await outboxFor(t, tenantId, caseId)).filter(
      (m) => m.kind === 'invitation',
    ).length;
    for (let i = sent; i < INVITES_PER_CASE_PER_HOUR; i += 1) {
      await inviteMember(t, {
        caseId,
        tenantId,
        role: 'marketing',
        email: `m${i}@eksempelbutik.dk`,
        invitedBy: 'Mette',
        baseUrl: BASE,
      });
    }
    const owner = await browser.newPage();
    await owner.goto(`${BASE}/en/c/${token}`);
    await owner.fill('form.invite input[name="from"]', 'Mette');
    await owner.fill('form.invite input[name="email"]', 'one-too-many@eksempelbutik.dk');
    await owner.click('form.invite button[type="submit"]');
    await owner.waitForURL(/outcome=rate_limited/);
    expect(await text(owner.locator('[role="alert"]'))).toContain('Too many invitations');
    expect(
      (await outboxFor(t, tenantId, caseId)).some((m) => m.to === 'one-too-many@eksempelbutik.dk'),
    ).toBe(false);
    await owner.close();
  });
});
