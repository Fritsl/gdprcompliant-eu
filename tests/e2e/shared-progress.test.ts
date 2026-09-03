import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256 } from '@gc/contracts';
import {
  SHARED_TENANT,
  createTestDatabase,
  inviteMember,
  openCase,
  outboxFor,
  runRetention,
  schema,
  testDatabaseUrl,
  withTenant,
  type TestDatabase,
} from '@gc/db';
import { loadCatalogue } from '@gc/remedies';

// Shared progress and chasing (P-03), in a real browser: everyone on the case sees the
// same counts per desk, a colleague sees nothing of another desk's findings, the
// owner sees who has not finished, and no reminder goes out unless the owner sends it.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WEB = join(ROOT, 'apps', 'web');
const PORT = 3419;
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

const FINDINGS = [
  { id: 'f-cns2', type: 'CNS-02', area: 'Consent', remedy: 'cns-02-gate-tags', status: 'closed' },
  {
    id: 'f-cns1',
    type: 'CNS-01',
    area: 'Consent',
    remedy: 'cns-01-gate-before-interaction',
    status: 'open',
  },
  { id: 'f-sec', type: 'SEC-03', area: 'Security', remedy: 'sec-03-hsts', status: 'open' },
  {
    id: 'f-trf',
    type: 'TRF-01',
    area: 'Transfers',
    remedy: 'trf-01-european-alternatives',
    status: 'open',
  },
] as const;

describe.skipIf(!url)('shared progress and chasing (P-03)', () => {
  let t: TestDatabase;
  let server: ChildProcess | undefined;
  let browser: Browser;
  let token = '';
  let caseId = '';
  let tenantId = '';
  let inviteLink = '';

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
    const catalogue = loadCatalogue();
    for (const f of FINDINGS) {
      const entry = catalogue.get(f.remedy)!;
      await t.db
        .insert(schema.remedies)
        .values({
          id: f.remedy,
          version: entry.remedy.version,
          tenantId: SHARED_TENANT,
          sourceRef: 'catalogue',
          findingTypeId: f.type,
          kind: entry.remedy.kind,
          jurisdictions: entry.remedy.jurisdictions,
          content: {},
          hash: sha256(f.remedy),
        })
        .onConflictDoNothing();
      await withTenant(t, tenantId, (db) =>
        db.insert(schema.findings).values({
          id: f.id,
          tenantId,
          sourceRef: 'test',
          caseId,
          typeId: f.type,
          fingerprint: `${f.type}|x`,
          jurisdiction: 'DK',
          binding: {},
          severity: 'serious',
          status: f.status,
          area: f.area,
          remedyId: f.remedy,
          remedyVersion: entry.remedy.version,
          firstSeenAt: new Date(),
          lastSeenAt: new Date(),
          ...(f.status === 'closed' ? { closedAt: new Date() } : {}),
        }),
      );
    }
    const invite = await inviteMember(t, {
      caseId,
      tenantId,
      role: 'it',
      email: 'lars@eksempelbutik.dk',
      invitedBy: 'Mette',
      baseUrl: BASE,
      locale: 'en',
    });
    inviteLink = invite.link;

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

  it("everyone sees the same counts per desk; a colleague sees none of another desk's findings", async () => {
    const owner = await browser.newPage();
    await owner.goto(`${BASE}/en/c/${token}`);
    const ownerProgress = await text(owner.locator('section.progress'));
    expect(ownerProgress).toContain('Where the case stands');
    expect(ownerProgress).toMatch(/1\/4 · 25%/);
    expect(ownerProgress).toContain('Marketing: 1 done, 1 open');
    expect(ownerProgress).toContain('IT / Operations: 0 done, 1 open');
    expect(ownerProgress).toContain('Finance / Legal: 0 done, 1 open');
    expect(await text(owner.locator('.colleague-list li[data-role="it"]'))).toContain('1 open');

    const colleague = await (await browser.newContext()).newPage();
    await colleague.goto(inviteLink);
    const memberProgress = await text(colleague.locator('section.progress'));
    expect(memberProgress).toBe(ownerProgress);
    const html = await colleague.content();
    // Their own item, by its remedy title; nothing that belongs to another desk.
    expect(html).toContain('Tell browsers to stay on HTTPS');
    for (const never of [
      'CNS-01',
      'CNS-02',
      'TRF-01',
      'Move the tags',
      'European alternative',
      'Delete this case',
      '/export.json',
    ]) {
      expect(html, never).not.toContain(never);
    }
    await colleague.close();
    await owner.close();
  });

  it('no reminder goes out on its own: the sweep sends none, the owner does', async () => {
    await runRetention(t, new Date(Date.now() + 30 * 86_400_000));
    expect((await outboxFor(t, tenantId, caseId)).map((m) => m.kind)).toEqual(['invitation']);

    const owner = await browser.newPage();
    await owner.goto(`${BASE}/en/c/${token}`);
    await owner
      .locator('.colleague-list li[data-role="it"] form[action*="/remind/"] button')
      .click();
    await owner.waitForURL(new RegExp(`/en/c/${token}$`));
    expect((await outboxFor(t, tenantId, caseId)).map((m) => m.kind)).toEqual([
      'invitation',
      'reminder',
    ]);
    await owner.close();
  });
});
