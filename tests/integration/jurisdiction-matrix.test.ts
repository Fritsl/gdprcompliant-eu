import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Finding, Jurisdiction } from '@gc/contracts';
import {
  createTestDatabase,
  exportCase,
  findingsForCase,
  openCase,
  seedRemedies,
  storeEvidence,
  storeFindings,
  testDatabaseUrl,
  type TestDatabase,
} from '@gc/db';
import {
  UnsupportedJurisdiction,
  draftsFromSecurity,
  findingIdentity,
  raiseFindings,
} from '@gc/findings';
import { loadCatalogue } from '@gc/remedies';
import {
  BrowserPool,
  FixtureServer,
  collectPassA,
  loadFixtureSites,
  runSecurityChecks,
} from '@gc/scanner';

// The jurisdiction matrix (T-08): one fixture, scanned once, raised as a Danish case and
// as a German case. The findings are the same findings — same types, same fingerprints —
// bound differently: other citations, another authority. Stored in two cases, neither
// case's rows or export carry the other country's authority. A jurisdiction the product
// does not speak fails with a message, not with someone else's law.

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
const catalogue = loadCatalogue();
const sites = loadFixtureSites();
let server: FixtureServer;
let pool: BrowserPool;
let db: TestDatabase;
let drafts: ReturnType<typeof draftsFromSecurity>;
let evidence: Awaited<ReturnType<typeof runSecurityChecks>>['evidence'];
const raised: Partial<Record<Jurisdiction, Finding[]>> = {};
const cases: Partial<Record<Jurisdiction, { tenantId: string; caseId: string; token: string }>> =
  {};

beforeAll(async () => {
  server = await new FixtureServer(sites.flatMap((s) => s.hosts)).start();
  pool = await new BrowserPool({
    concurrency: 2,
    passTimeoutMs: 60_000,
    navigationTimeoutMs: 10_000,
    launch: { proxy: { server: server.proxy } },
    ignoreHTTPSErrors: true,
  }).start();
  if (url) {
    db = await createTestDatabase(url);
    await seedRemedies(db, catalogue);
  }
});

afterAll(async () => {
  await pool?.stop();
  await server?.stop();
  await db?.drop();
});

async function scanOnce(identity: { tenantId: string; caseId: string }) {
  const target = 'https://usikker.test/';
  const { capture } = await collectPassA(pool, { url: target }, { quiet: { minDwellMs: 1_000 } });
  const surface = await runSecurityChecks(
    pool,
    { url: target },
    { capture, identity: { ...identity, scanId: 'scan-1', capturedAt: T0.toISOString() } },
  );
  return {
    drafts: draftsFromSecurity(surface.observations, 'usikker.test'),
    evidence: surface.evidence,
  };
}

describe('one fixture, several countries', () => {
  it('raises the same identities for DK and DE, bound differently', async () => {
    const scanned = await scanOnce({ tenantId: 't-matrix', caseId: 'DK-26-MTRX' });
    drafts = scanned.drafts;
    evidence = scanned.evidence;
    expect(drafts.map((d) => d.typeId)).toEqual([
      'SEC-01',
      'SEC-02',
      'SEC-03',
      'SEC-04',
      'SEC-05',
      'SEC-06',
      'SEC-07',
    ]);
    for (const jurisdiction of ['DK', 'DE'] as const) {
      raised[jurisdiction] = raiseFindings(drafts, {
        tenantId: 't-matrix',
        caseId: 'XX-26-MTRX',
        jurisdiction,
        catalogue,
        scanId: 'scan-1',
        now: () => T0,
      });
    }
    const dk = raised.DK!;
    const de = raised.DE!;
    expect(dk.map(findingIdentity)).toEqual(de.map(findingIdentity));
    expect(dk.map((f) => f.id)).toEqual(de.map((f) => f.id));
    expect(dk.map((f) => f.severity)).toEqual(de.map((f) => f.severity));
    for (let i = 0; i < dk.length; i += 1) {
      const a = dk[i]!;
      const b = de[i]!;
      expect(a.binding.jurisdiction).toBe('DK');
      expect(b.binding.jurisdiction).toBe('DE');
      expect(a.binding.authority.name).toBe('Datatilsynet');
      expect(b.binding.authority.name).not.toBe('Datatilsynet');
      expect(a.binding.authority).not.toEqual(b.binding.authority);
      expect(a.binding.guideId).toBe(b.binding.guideId);
      expect(a.remedy).toEqual(b.remedy);
      // The citations are the same Union provisions today; they are still bound per
      // jurisdiction, and a national instrument joins the table when it joins the corpus.
      expect(a.binding.citations.length).toBeGreaterThan(0);
    }
  });

  it('an unsupported jurisdiction fails with a message, never with another country’s law', () => {
    const attempt = () =>
      raiseFindings(drafts, {
        tenantId: 't-matrix',
        caseId: 'FR-26-MTRX',
        jurisdiction: 'FR',
        catalogue,
        now: () => T0,
      });
    expect(attempt).toThrow(UnsupportedJurisdiction);
    expect(attempt).toThrow(
      "no binding table for jurisdiction FR; the product speaks DE, DK and does not answer with another country's law",
    );
  });

  it.skipIf(!url)(
    'stored in two cases, neither case carries the other country’s authority',
    async () => {
      for (const jurisdiction of ['DK', 'DE'] as const) {
        const opened = await openCase(db, {
          company: {
            domain: 'usikker.test',
            country: jurisdiction,
            locale: jurisdiction === 'DK' ? 'da' : 'de',
          },
          jurisdiction,
          locale: jurisdiction === 'DK' ? 'da' : 'de',
          now: () => T0,
        });
        cases[jurisdiction] = {
          tenantId: opened.tenantId,
          caseId: opened.caseId,
          token: opened.accessToken,
        };
        const own = evidence.map((e) => ({
          ...e,
          tenantId: opened.tenantId,
          caseId: opened.caseId,
        }));
        await storeEvidence(db, opened.tenantId, own);
        const findings = raiseFindings(drafts, {
          tenantId: opened.tenantId,
          caseId: opened.caseId,
          jurisdiction,
          catalogue,
          scanId: 'scan-1',
          now: () => T0,
        });
        await storeFindings(db, opened.tenantId, findings);
      }
      const dkRows = await findingsForCase(db, cases.DK!.tenantId, cases.DK!.caseId);
      const deRows = await findingsForCase(db, cases.DE!.tenantId, cases.DE!.caseId);
      expect(dkRows.map((r) => r.typeId)).toEqual(deRows.map((r) => r.typeId));
      expect(dkRows.map((r) => r.fingerprint)).toEqual(deRows.map((r) => r.fingerprint));
      for (const r of dkRows)
        expect((r.binding as { authority: { name: string } }).authority.name).toBe('Datatilsynet');
      for (const r of deRows) expect(JSON.stringify(r.binding)).not.toContain('Datatilsynet');
      expect(cases.DK!.caseId.startsWith('DK-')).toBe(true);
      expect(cases.DE!.caseId.startsWith('DE-')).toBe(true);

      const deExport = await exportCase(db, cases.DE!.tenantId, cases.DE!.caseId, {
        locale: 'de',
        now: () => T0,
      });
      expect(deExport.json).not.toContain('Datatilsynet');
      const dkExport = await exportCase(db, cases.DK!.tenantId, cases.DK!.caseId, {
        locale: 'da',
        now: () => T0,
      });
      expect(dkExport.json).toContain('Datatilsynet');
      expect(dkExport.json).not.toContain('Bundesland');
    },
  );
});
