import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FindingSchema, canonicalJson, sha256 } from '@gc/contracts';
import {
  createTestDatabase,
  findingsForCase,
  openCase,
  reconcileFindings,
  seedRemedies,
  storeEvidence,
  testDatabaseUrl,
  type TestDatabase,
} from '@gc/db';
import {
  DraftWithoutEvidence,
  NoRemedy,
  UnregisteredFindingType,
  assembleFindings,
} from '@gc/findings';
import { loadCatalogue } from '@gc/remedies';
import {
  BrowserPool,
  FixtureServer,
  collectPassA,
  inventoryForms,
  loadFixtureSites,
  runSecurityChecks,
} from '@gc/scanner';

// Finding assembly (S-14): the checks' output becomes findings with severity from the
// table, evidence, binding and remedy; the same scan assembled twice is the same bytes;
// ids survive re-scans, so a finding seen again is the same row, one that came back is
// regressed, one that is gone is closed; and a draft without evidence or a type without
// a remedy is refused.

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
const at = (s: number) => new Date(T0.getTime() + s * 1000);
const catalogue = loadCatalogue();
const sites = loadFixtureSites();
let server: FixtureServer;
let pool: BrowserPool;
let db: TestDatabase;
let input: Parameters<typeof assembleFindings>[0];
let evidenceRows: Awaited<ReturnType<typeof runSecurityChecks>>['evidence'];

beforeAll(async () => {
  server = await new FixtureServer(sites.flatMap((s) => s.hosts)).start();
  pool = await new BrowserPool({
    concurrency: 2,
    passTimeoutMs: 60_000,
    navigationTimeoutMs: 10_000,
    launch: { proxy: { server: server.proxy } },
    ignoreHTTPSErrors: true,
  }).start();
  const identity = {
    tenantId: 't-1',
    caseId: 'DK-26-0M4K',
    scanId: 'scan-1',
    capturedAt: T0.toISOString(),
  };
  const target = { url: 'https://usikker.test/' };
  const { capture } = await collectPassA(pool, target, { quiet: { minDwellMs: 800 } });
  const surface = await runSecurityChecks(pool, target, { capture, identity });
  const forms = await inventoryForms(pool, target, { identity });
  input = { security: surface.observations, forms: forms.inventory.observations };
  evidenceRows = [...surface.evidence, ...forms.evidence];
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

const ctx = (over: Partial<Parameters<typeof assembleFindings>[1]> = {}) => ({
  tenantId: 't-1',
  caseId: 'DK-26-0M4K',
  jurisdiction: 'DK' as const,
  catalogue,
  host: 'usikker.test',
  scanId: 'scan-1',
  now: () => T0,
  ...over,
});

describe('assembling the insecure shop', () => {
  it('turns every failed check into a finding with severity, evidence, binding and remedy', () => {
    const { findings, detail } = assembleFindings(input, ctx());
    expect(findings.map((f) => f.typeId)).toEqual([
      'FRM-03',
      'SEC-01',
      'SEC-02',
      'SEC-03',
      'SEC-04',
      'SEC-05',
      'SEC-06',
      'SEC-07',
    ]);
    for (const f of findings) {
      expect(FindingSchema.safeParse(f).success).toBe(true);
      expect(f.evidence.length).toBeGreaterThan(0);
      expect(f.binding.jurisdiction).toBe('DK');
      expect(f.remedy.remedyId).toBeTruthy();
      expect(f.fingerprint).toBe(`${f.typeId}|usikker.test||`);
    }
    const frm = detail.find((d) => d.finding.typeId === 'FRM-03')!;
    expect(frm.severity.base).toBe('serious');
    expect(['serious', 'blocking']).toContain(frm.severity.severity);
    const sec01 = detail.find((d) => d.finding.typeId === 'SEC-01')!;
    expect(sec01.severity).toEqual({ severity: 'blocking', base: 'blocking', applied: [] });
  });

  it('is byte-identical when assembled twice, and keeps its ids when assembled later', () => {
    const first = assembleFindings(input, ctx());
    const second = assembleFindings(input, ctx());
    expect(canonicalJson(second.findings)).toBe(canonicalJson(first.findings));
    expect(second.digest).toBe(first.digest);
    expect(first.digest).toBe(sha256(canonicalJson(first.findings)));
    const later = assembleFindings(input, ctx({ now: () => at(3600) }));
    expect(later.findings.map((f) => f.id)).toEqual(first.findings.map((f) => f.id));
    expect(later.digest).not.toBe(first.digest);
  });

  it('refuses a draft without evidence, an unregistered type, and a type without a remedy', () => {
    expect(() =>
      assembleFindings(
        { drafts: [{ typeId: 'SEC-03', subject: { host: 'x.test' }, evidence: [] }] },
        ctx(),
      ),
    ).toThrow(DraftWithoutEvidence);
    const ref = { evidenceId: 'text:0000000000000000', hash: 'a'.repeat(64) };
    expect(() =>
      assembleFindings({ drafts: [{ typeId: 'XYZ-99', evidence: [ref] }] }, ctx()),
    ).toThrow(UnregisteredFindingType);
    expect(() =>
      assembleFindings(
        { drafts: [{ typeId: 'SEC-03', evidence: [ref] }] },
        ctx({ catalogue: { forFinding: () => [] } as unknown as typeof catalogue }),
      ),
    ).toThrow(NoRemedy);
  });

  it('folds two drafts of the same identity into one finding with both pieces of evidence', () => {
    const a = { evidenceId: 'text:aaaaaaaaaaaaaaaa', hash: 'a'.repeat(64) };
    const b = { evidenceId: 'text:bbbbbbbbbbbbbbbb', hash: 'b'.repeat(64) };
    const { findings, folded } = assembleFindings(
      {
        drafts: [
          { typeId: 'SEC-03', subject: { host: 'usikker.test' }, evidence: [a] },
          { typeId: 'SEC-03', subject: { host: 'usikker.test' }, evidence: [b] },
        ],
      },
      ctx(),
    );
    expect(folded).toBe(1);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.evidence.map((e) => e.evidenceId)).toEqual([a.evidenceId, b.evidenceId]);
  });
});

describe.skipIf(!url)('re-scans against the case', () => {
  it('the same problem is the same row; gone is closed; back is regressed and one level up', async () => {
    const opened = await openCase(db, {
      company: { domain: 'usikker.test', country: 'DK', locale: 'da' },
      jurisdiction: 'DK',
      locale: 'da',
      now: () => T0,
    });
    const c = ctx({ tenantId: opened.tenantId, caseId: opened.caseId });
    await storeEvidence(
      db,
      opened.tenantId,
      evidenceRows.map((e) => ({ ...e, tenantId: opened.tenantId, caseId: opened.caseId })),
    );

    const first = assembleFindings(input, c);
    const r1 = await reconcileFindings(db, opened.tenantId, opened.caseId, first.findings, T0);
    expect(r1.opened).toHaveLength(first.findings.length);
    expect([r1.seenAgain, r1.regressed, r1.closed]).toEqual([[], [], []]);

    const again = assembleFindings(input, { ...c, now: () => at(60) });
    const r2 = await reconcileFindings(db, opened.tenantId, opened.caseId, again.findings, at(60));
    expect(r2.seenAgain.sort()).toEqual(r1.opened.sort());
    expect(r2.opened).toEqual([]);
    let rows = await findingsForCase(db, opened.tenantId, opened.caseId);
    expect(rows.map((r) => r.id).sort()).toEqual(r1.opened.sort());
    for (const r of rows) expect(new Date(r.lastSeenAt).toISOString()).toBe(at(60).toISOString());

    // HSTS gets fixed: the finding is no longer observed, so it closes.
    const withoutHsts = {
      security: input.security!.filter((o) => o.findingTypeId !== 'SEC-03'),
      forms: input.forms,
    };
    const fixed = assembleFindings(withoutHsts, { ...c, now: () => at(120) });
    const r3 = await reconcileFindings(db, opened.tenantId, opened.caseId, fixed.findings, at(120));
    expect(r3.closed).toHaveLength(1);
    rows = await findingsForCase(db, opened.tenantId, opened.caseId);
    const hsts = rows.find((r) => r.typeId === 'SEC-03')!;
    expect(hsts.status).toBe('closed');
    expect(hsts.closedAt).not.toBeNull();
    expect(hsts.severity).toBe('serious');

    // Then it comes back: same id, regressed, one level more serious.
    const previous = new Map(rows.map((r) => [r.fingerprint, r.status as 'closed' | 'open']));
    const back = assembleFindings(input, { ...c, now: () => at(180), previous });
    const r4 = await reconcileFindings(db, opened.tenantId, opened.caseId, back.findings, at(180));
    expect(r4.regressed).toEqual([hsts.id]);
    rows = await findingsForCase(db, opened.tenantId, opened.caseId);
    const returned = rows.find((r) => r.typeId === 'SEC-03')!;
    expect(returned.id).toBe(hsts.id);
    expect(returned.status).toBe('regressed');
    expect(returned.closedAt).toBeNull();
    expect(returned.severity).toBe('blocking');
    expect(back.detail.find((d) => d.finding.typeId === 'SEC-03')!.severity.applied).toEqual([
      'regressed',
    ]);
  });
});
