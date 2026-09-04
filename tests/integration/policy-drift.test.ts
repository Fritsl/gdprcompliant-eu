import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CheckFamily, Evidence } from '@gc/contracts';
import {
  CONTACT_QUESTIONS,
  confirmRegisterRow,
  createTestDatabase,
  findingsWithEvidence,
  generateDocument,
  openCase,
  publishArtefact,
  recordAnswer,
  registerRows,
  runWatch,
  schema,
  seedRegister,
  seedRemedies,
  signArtefact,
  storeEvidence,
  testDatabaseUrl,
  withTenant,
  type CheckRun,
  type TestDatabase,
} from '@gc/db';
import { loadCatalogue } from '@gc/remedies';
import {
  BrowserPool,
  FixtureServer,
  applyOverrides,
  loadFixtureSites,
  resolveHost,
  runChecks,
  type FixtureHost,
} from '@gc/scanner';
import { eq } from 'drizzle-orm';

// The drift check (G-05), on the fixture estate: the tag-manager shop gets a published
// privacy policy written from its register; a watch cycle over a cosmetic change raises
// nothing; a watch cycle over a page that now also loads a replay tool raises one
// finding that names what the policy says and what the site does.

const url = (() => {
  try {
    return testDatabaseUrl();
  } catch (e) {
    if (process.env['CI']) throw e;
    console.warn((e as Error).message);
    return undefined;
  }
})();

const T0 = new Date('2026-09-04T09:14:00Z');
const later = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const sites = loadFixtureSites();
const SITE = 'https://tags.shop.test/';
const mette = { kind: 'person' as const, userId: 'u-mette', name: 'Mette' };

describe.skipIf(!url)('the drift check (G-05)', () => {
  let t: TestDatabase;
  let tenantId = '';
  let caseId = '';
  let server: FixtureServer;
  let pool: BrowserPool;
  const catalogue = loadCatalogue();
  const quiet = { minDwellMs: 1_500, quietMs: 500, maxWaitMs: 8_000 };

  const shop = () => sites.find((s) => s.expected.site === 'tags.shop.test')!;
  const startPool = () =>
    new BrowserPool({
      concurrency: 2,
      passTimeoutMs: 60_000,
      navigationTimeoutMs: 15_000,
      launch: { proxy: { server: server.proxy } },
      ignoreHTTPSErrors: true,
      resolveEgress: false,
    }).start();
  const shopHost = () => shop().hosts.find((h) => h.host === 'tags.shop.test')!;

  // A scan of the estate with one host replaced, as the watch would run it.
  const runner =
    (hosts: readonly FixtureHost[], scanId: string, now: Date) =>
    async (families: readonly CheckFamily[]): Promise<CheckRun> => {
      await server.stop();
      server = await new FixtureServer(hosts).start();
      await pool.stop();
      pool = await startPool();
      const out = await runChecks(
        pool,
        { url: SITE },
        {
          identity: { tenantId, caseId, scanId, capturedAt: now.toISOString() },
          families: families.filter((f): f is Exclude<CheckFamily, 'ct'> => f !== 'ct'),
          quiet,
          now: () => now,
        },
      );
      return {
        families,
        input: {
          ...(out.security ? { security: out.security } : {}),
          ...(out.recipients ? { recipients: out.recipients } : {}),
          ...(out.forms ? { forms: out.forms } : {}),
          ...(out.replay ? { replay: out.replay } : {}),
          ...(out.policies ? { policies: out.policies } : {}),
          ...(out.consent ? { consent: out.consent } : {}),
        },
        evidence: out.evidence,
        checksRun: out.checksRun,
        checksPassed: out.checksPassed,
        undetermined: out.undetermined,
        durationMs: out.durationMs,
      };
    };

  beforeAll(async () => {
    t = await createTestDatabase(url);
    await seedRemedies(t, catalogue);
    const opened = await openCase(t, {
      company: {
        domain: 'tags.shop.test',
        legalName: 'Tags Shop ApS',
        country: 'DK',
        locale: 'da',
      },
      jurisdiction: 'DK',
      locale: 'da',
      now: () => T0,
    });
    tenantId = opened.tenantId;
    caseId = opened.caseId;
    server = await new FixtureServer(sites.flatMap((s) => s.hosts)).start();
    pool = await startPool();

    // The first scan: recipients read, register seeded, rows confirmed, contact answered,
    // policy written, signed and published.
    const identity = { tenantId, caseId, scanId: 'scan-0', capturedAt: T0.toISOString() };
    const first = await runChecks(
      pool,
      { url: SITE },
      { identity, families: ['recipients'], quiet },
    );
    await storeEvidence(t, tenantId, first.evidence as Evidence[]);
    await seedRegister(t, tenantId, caseId, {
      scanId: 'scan-0',
      now: T0,
      ...(first.recipients ? { recipients: first.recipients } : {}),
      resolve: resolveHost,
    });
    for (const row of await registerRows(t, tenantId, caseId)) {
      await confirmRegisterRow(t, tenantId, {
        caseId,
        activityId: row.activityId,
        answerId: `Q-${row.name}`,
        by: 'Mette',
        at: later(1),
        corrections: { retention: '26 måneder' },
      });
    }
    await recordAnswer(t, tenantId, {
      caseId,
      questionId: CONTACT_QUESTIONS.address,
      answer: 'Kaffevej 2, 8000 Aarhus C',
      by: mette,
      at: T0,
    });
    await recordAnswer(t, tenantId, {
      caseId,
      questionId: CONTACT_QUESTIONS.email,
      answer: 'privatliv@tags.shop.test',
      by: mette,
      at: T0,
    });
    const generated = await generateDocument(t, tenantId, {
      caseId,
      kind: 'privacy_policy',
      by: mette,
      now: later(2),
    });
    if (!generated.ok)
      throw new Error(`policy not written: ${generated.gaps.map((g) => g.text).join('; ')}`);
    await signArtefact(t, tenantId, generated.artefact.id, {
      by: mette,
      version: generated.artefact.version,
      hash: generated.artefact.hash,
      now: later(3),
    });
    await publishArtefact(t, tenantId, generated.artefact.id, {
      by: mette,
      url: 'https://tags.shop.test/privatlivspolitik',
      now: later(4),
    });
  }, 300_000);

  afterAll(async () => {
    await pool?.stop();
    await server?.stop();
    await t?.drop();
  });

  const openFindings = () =>
    withTenant(t, tenantId, (db) =>
      db.select().from(schema.findings).where(eq(schema.findings.caseId, caseId)),
    );

  it('the published policy names the recipient the site had, and a cosmetic change raises nothing', async () => {
    const cosmetic = applyOverrides(shopHost(), {
      replace: {
        '/index.html': [
          ['<h1>Tags Shop</h1>', '<h1 class="brand">Tags Shop</h1>'],
          [
            '<p>Velkommen. Vi sælger kaffe og te.</p>',
            '<p class="lead">Velkommen! Vi sælger kaffe, te og kakao.</p>',
          ],
        ],
      },
    });
    const hosts = sites.flatMap((s) => s.hosts).map((h) => (h === shopHost() ? cosmetic : h));
    const run = await runWatch(t, tenantId, caseId, {
      catalogue,
      run: runner(hosts, 'watch-1', later(10)),
      host: 'tags.shop.test',
      now: () => later(10),
      resolve: resolveHost,
    });
    expect(run.drift.policy).toBeDefined();
    expect(run.drift.named.map((n) => n.name)).toContain('Google Ireland Limited');
    expect(run.drift.observed).toContain('www.googletagmanager.com');
    expect(run.drift.unnamed).toEqual([]);
    const findings = await openFindings();
    expect(findings.some((f) => f.typeId === 'POL-05')).toBe(false);
  });

  it('a vendor added to the site and not named in the policy raises one finding within a watch cycle, naming both sides', async () => {
    const changed = applyOverrides(shopHost(), {
      replace: {
        '/index.html': [
          [
            '  <script src="https://www.googletagmanager.com/gtm.js?id=GTM-TEST"></script>\n',
            '  <script src="https://www.googletagmanager.com/gtm.js?id=GTM-TEST"></script>\n  <script src="https://static.hotjar.com/c/hotjar-123.js?sv=6"></script>\n',
          ],
        ],
      },
    });
    const hosts = sites.flatMap((s) => s.hosts).map((h) => (h === shopHost() ? changed : h));
    const run = await runWatch(t, tenantId, caseId, {
      catalogue,
      run: runner(hosts, 'watch-2', later(20)),
      host: 'tags.shop.test',
      now: () => later(20),
      resolve: resolveHost,
    });
    expect(run.drift.unnamed).toEqual([
      { host: 'static.hotjar.com', vendor: { id: 'hotjar', name: 'Hotjar Limited' } },
    ]);
    const findings = await openFindings();
    const drift = findings.filter((f) => f.typeId === 'POL-05');
    expect(drift).toHaveLength(1);
    expect(drift[0]!.status).toBe('open');
    expect(drift[0]!.remedyId).toBe('pol-05-name-the-recipient');
    // Both sides, on the finding's own evidence row.
    const withEvidence = await findingsWithEvidence(t, tenantId, caseId);
    const sides = withEvidence
      .find((x) => x.finding.id === drift[0]!.id)!
      .evidence.find((e) => e.kind === 'text')!;
    expect(sides.caption).toContain('names Google Ireland Limited');
    expect(sides.caption).toContain('static.hotjar.com (Hotjar Limited)');
    expect(sides.caption).toContain('which it does not name');
    const body = JSON.parse(sides.body) as {
      policy: { version: number; names: { name: string }[] };
      site: { unnamed: { host: string }[] };
    };
    expect(body.policy.names.map((n) => n.name)).toContain('Google Ireland Limited');
    expect(body.site.unnamed.map((u) => u.host)).toEqual(['static.hotjar.com']);
    expect(run.record.opened).toContain(drift[0]!.id);
  });

  it('the same site again raises nothing new, and the finding stays open until the policy names the recipient', async () => {
    const changed = applyOverrides(shopHost(), {
      replace: {
        '/index.html': [
          [
            '  <script src="https://www.googletagmanager.com/gtm.js?id=GTM-TEST"></script>\n',
            '  <script src="https://www.googletagmanager.com/gtm.js?id=GTM-TEST"></script>\n  <script src="https://static.hotjar.com/c/hotjar-123.js?sv=6"></script>\n',
          ],
        ],
      },
    });
    const hosts = sites.flatMap((s) => s.hosts).map((h) => (h === shopHost() ? changed : h));
    const run = await runWatch(t, tenantId, caseId, {
      catalogue,
      run: runner(hosts, 'watch-3', later(30)),
      host: 'tags.shop.test',
      now: () => later(30),
      resolve: resolveHost,
    });
    const drift = (await openFindings()).filter((f) => f.typeId === 'POL-05');
    expect(drift).toHaveLength(1);
    expect(run.record.seenAgain).toContain(drift[0]!.id);
    expect(run.record.opened).not.toContain(drift[0]!.id);
  });
});
