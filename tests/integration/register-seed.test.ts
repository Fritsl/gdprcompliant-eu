import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REGISTER_CONTENT, registerDocument } from '@gc/artefacts';
import { RegisterRowSchema, type Company, type Evidence } from '@gc/contracts';
import {
  confirmRegisterRow,
  createTestDatabase,
  editEffort,
  openCase,
  openContradictions,
  registerRows,
  schema,
  seedRegister,
  storeEvidence,
  testDatabaseUrl,
  withTenant,
  type RegisterTruthRow,
  type TestDatabase,
} from '@gc/db';
import { bannedClaims, loadClaimVocabulary } from '@gc/i18n';
import { BrowserPool, FixtureServer, loadFixtureSites, runChecks } from '@gc/scanner';

// The register seeded from evidence (G-01), on the fixture company's estate: the sign-up,
// checkout and contact forms of tilmeld.test and the tag manager of tags.shop.test are
// scanned in a real browser; what they show becomes draft rows that are visibly drafts,
// each citing the evidence it came from; a person confirms one with corrections; the
// export reads as an Article 30 record in the case's language; and correcting the
// drafts costs far fewer edits than writing the register from nothing.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
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
const sites = loadFixtureSites();
const vocab = loadClaimVocabulary();
const truth = JSON.parse(
  readFileSync(join(ROOT, 'fixtures', 'companies', 'eksempelbutik-register.json'), 'utf8'),
) as { activities: RegisterTruthRow[] };
const company: Company = JSON.parse(
  readFileSync(join(ROOT, 'fixtures', 'companies', 'eksempelbutik.json'), 'utf8'),
).company;

describe.skipIf(!url)('the register seeded from evidence (G-01)', () => {
  let t: TestDatabase;
  let tenantId = '';
  let caseId = '';
  let seeded: Awaited<ReturnType<typeof seedRegister>>;

  beforeAll(async () => {
    t = await createTestDatabase(url);
    const opened = await openCase(t, {
      company: { domain: 'eksempelbutik.dk', country: 'DK', locale: 'da' },
      jurisdiction: 'DK',
      locale: 'da',
      now: () => T0,
    });
    tenantId = opened.tenantId;
    caseId = opened.caseId;
    const identity = { tenantId, caseId, scanId: 'scan-g01', capturedAt: T0.toISOString() };

    // Scan the two fixture sites the company's estate is made of.
    const server = await new FixtureServer(sites.flatMap((s) => s.hosts)).start();
    const pool = await new BrowserPool({
      concurrency: 2,
      passTimeoutMs: 60_000,
      navigationTimeoutMs: 15_000,
      launch: { proxy: { server: server.proxy } },
      ignoreHTTPSErrors: true,
      resolveEgress: false,
    }).start();
    try {
      const quiet = { minDwellMs: 1_500, quietMs: 500, maxWaitMs: 8_000 };
      const forms = await runChecks(
        pool,
        { url: 'http://tilmeld.test/' },
        { identity, families: ['forms'], quiet },
      );
      const tags = await runChecks(
        pool,
        { url: 'https://tags.shop.test/' },
        { identity, families: ['recipients'], quiet },
      );
      const evidence: Evidence[] = [...forms.evidence, ...tags.evidence];
      await storeEvidence(t, tenantId, evidence);
      seeded = await seedRegister(t, tenantId, caseId, {
        scanId: 'scan-g01',
        now: T0,
        ...(forms.formInventory ? { forms: forms.formInventory } : {}),
        ...(tags.recipients ? { recipients: tags.recipients } : {}),
      });
    } finally {
      await pool.stop();
      await server.stop();
    }
  }, 300_000);

  afterAll(async () => {
    await t?.drop();
  });

  it('every row is a draft, derived, and cites evidence that exists on the case', async () => {
    expect(seeded.nodes).toBeGreaterThan(5);
    const rows = await registerRows(t, tenantId, caseId);
    expect(rows.length).toBeGreaterThanOrEqual(4);
    const stored = new Set(
      (
        await withTenant(t, tenantId, (db) =>
          db.select({ id: schema.evidence.id }).from(schema.evidence),
        )
      ).map((e) => e.id),
    );
    for (const row of rows) {
      expect(RegisterRowSchema.safeParse(row).success, row.key).toBe(true);
      expect(row.draft, row.key).toBe(true);
      expect(row.origin).toBe('derived');
      expect(row.confidence).toBeLessThan(1);
      expect(row.evidence.length, row.key).toBeGreaterThan(0);
      for (const e of row.evidence)
        expect(stored.has(e.evidenceId), `${row.key} cites ${e.evidenceId}`).toBe(true);
      expect(row.legalBases.length, `${row.key} has a likely basis`).toBe(1);
    }
    const names = rows.map((r) => r.name).sort();
    expect(names).toEqual(
      expect.arrayContaining([
        'newsletter',
        'orders',
        'sensitive_enquiries',
        'website_measurement',
      ]),
    );
    const measurement = rows.find((r) => r.name === 'website_measurement')!;
    expect(measurement.recipients.map((r) => r.name)).toContain('Google Ireland Limited');
    expect(measurement.transfers.length).toBeGreaterThan(0);
    expect(measurement.transfers[0]!.attributes['situation']).toBe('eea_entity_non_eea_parent');
    const orders = rows.find((r) => r.name === 'orders')!;
    expect(orders.dataCategories).toEqual(expect.arrayContaining(['contact', 'financial']));
    // Nothing is stored as a register row; the graph is the only home.
    expect(
      await withTenant(t, tenantId, (db) => db.select().from(schema.processingActivities)),
    ).toEqual([]);
  });

  it('correcting the drafts costs far fewer edits than writing the register from nothing', async () => {
    const rows = await registerRows(t, tenantId, caseId);
    const effort = editEffort(rows, truth.activities);
    console.log(
      `register edits: ${effort.fromDrafts} from the drafts, ${effort.fromNothing} from nothing`,
      effort.detail,
    );
    expect(effort.fromNothing).toBeGreaterThan(12);
    expect(effort.fromDrafts).toBeLessThanOrEqual(Math.floor(effort.fromNothing * 0.4));
  });

  it('a draft counts for nothing until a person confirms it, corrections and all', async () => {
    const before = await registerRows(t, tenantId, caseId);
    const enquiries = before.find((r) => r.name === 'sensitive_enquiries')!;
    const confirmed = await confirmRegisterRow(t, tenantId, {
      caseId,
      activityId: enquiries.activityId,
      answerId: 'Q-register-enquiries',
      by: 'Mette',
      at: new Date(T0.getTime() + 3_600_000),
      corrections: { dataSubjects: ['customers'], retention: 'Slettes efter 12 måneder' },
    });
    expect(confirmed).toMatchObject({
      name: 'sensitive_enquiries',
      draft: false,
      origin: 'answered',
      confidence: 1,
      legalBases: ['explicit_consent'],
      contradictions: 0,
    });
    expect(confirmed.attributes['retention']).toBe('Slettes efter 12 måneder');
    expect(confirmed.attributes['dataSubjects']).toEqual(['customers']);
    expect(confirmed.dataCategories.sort()).toEqual(enquiries.dataCategories.sort());
    // The draft row is gone from the projection, superseded, not deleted.
    const after = await registerRows(t, tenantId, caseId);
    expect(after.filter((r) => r.name === 'sensitive_enquiries')).toHaveLength(1);
    expect(after.find((r) => r.name === 'newsletter')!.draft).toBe(true);
    expect(await withTenant(t, tenantId, (db) => openContradictions(db, caseId))).toEqual([]);
    const nodes = await withTenant(t, tenantId, (db) => db.select().from(schema.graphNodes));
    expect(nodes.some((n) => n.id === enquiries.activityId && n.supersededBy)).toBe(true);
  });

  it('the export reads as an Article 30 record in the case’s language, drafts marked, gaps named', async () => {
    const rows = await registerRows(t, tenantId, caseId);
    for (const locale of ['da', 'en'] as const) {
      const doc = registerDocument({ rows, company, locale, generatedAt: T0 });
      const C = REGISTER_CONTENT;
      expect(doc).toContain(`# ${C.title[locale]}`);
      expect(doc).toContain(C.basis[locale]!);
      expect(doc).toContain('Eksempelbutik ApS');
      for (const k of [
        'purposes',
        'dataSubjects',
        'dataCategories',
        'legalBases',
        'recipients',
        'transfers',
        'retention',
        'security',
      ])
        expect(doc, k).toContain(`**${C.columns[k]![locale]}:**`);
      expect(doc).toContain(C.draft[locale]!);
      expect(doc).toContain(C.confirmed[locale]!);
      expect(doc).toContain(C.notYetAnswered[locale]!);
      expect(doc).toContain('Google Ireland Limited (IE)');
      expect(doc).toContain(locale === 'da' ? 'Nyhedsbrev' : 'Newsletter');
      expect(doc).toContain(locale === 'da' ? 'inden for EØS' : 'inside the EEA');
      expect(doc).toContain('Slettes efter 12 måneder');
      expect(doc).toMatch(/[a-z_]+:[a-f0-9]{16}/);
      // The disclaimer after the rule names the claims it denies; the record itself makes none.
      expect(bannedClaims(doc.split('\n---\n')[0]!, locale, vocab)).toEqual([]);
    }
    expect(registerDocument({ rows: [], company, locale: 'en', generatedAt: T0 })).toContain(
      REGISTER_CONTENT.empty.en,
    );
  });
});
