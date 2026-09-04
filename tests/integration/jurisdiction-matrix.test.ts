import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Finding, Jurisdiction } from '@gc/contracts';
import {
  caseTimeline,
  createTestDatabase,
  exportCase,
  findingsForCase,
  openCase,
  seedRemedies,
  storeEvidence,
  storeFindings,
  testDatabaseUrl,
  withTenant,
  type TestDatabase,
} from '@gc/db';
import {
  UnsupportedJurisdiction,
  bindingTables,
  draftsFromSecurity,
  findingIdentity,
  raiseFindings,
} from '@gc/findings';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timelineModel } from '@gc/artefacts';
import { localise } from '@gc/i18n';
import { guideLocales, loadCatalogue, loadGuides } from '@gc/remedies';
import { evaluate, loadRuleSets } from '@gc/rules';
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

// The second jurisdiction end to end (I-04): a German company gets German bindings, the
// German authority and German text everywhere it reads, with no Danish string, article
// or authority anywhere in it, and the work was content and rules only: nothing in the
// detectors or the UI branches on a country.

const I04_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DANISH = /[æøåÆØÅ]|Datatilsynet|Databeskyttelsesloven|privatlivspolitik/;
const de = (text: Record<string, string>) => localise(text, 'de');

function walkTexts(value: unknown, out: Record<string, string>[] = []): Record<string, string>[] {
  if (Array.isArray(value)) for (const v of value) walkTexts(v, out);
  else if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (typeof o['en'] === 'string') out.push(o as Record<string, string>);
    else for (const v of Object.values(o)) walkTexts(v, out);
  }
  return out;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    if (f === 'node_modules' || f === '.next' || f === 'dist') continue;
    const p = join(dir, f);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.(ts|tsx)$/.test(f) && !/\.test\.ts$/.test(f)) out.push(p);
  }
  return out;
}

describe.skipIf(!url)('the second jurisdiction end to end (I-04)', () => {
  const catalogue = loadCatalogue();
  const guides = loadGuides();
  const sets = loadRuleSets();
  const table = bindingTables().get('DE')!;
  let t: TestDatabase;
  let caseId = '';
  let tenantId = '';

  beforeAll(async () => {
    t = await createTestDatabase(url);
    await seedRemedies(t, catalogue);
    const opened = await openCase(t, {
      company: {
        domain: 'beispielshop.de',
        legalName: 'Beispielshop GmbH',
        country: 'DE',
        locale: 'de',
      },
      jurisdiction: 'DE',
      locale: 'de',
    });
    caseId = opened.caseId;
    tenantId = opened.tenantId;
  });

  afterAll(async () => {
    await t?.drop();
  });

  it('binds every finding type to German law with the German authority, and a guide written in German', () => {
    expect(table.jurisdiction).toBe('DE');
    expect(table.authority.name).not.toMatch(DANISH);
    expect(table.authority.name).toMatch(/Bundesland|Landes|Aufsichtsbehörde/);
    expect(table.authority.url).toMatch(/\.de\//);
    for (const b of table.bindings) {
      expect(b.citations.length, b.findingTypeId).toBeGreaterThan(0);
      // A binding's guide, where one is written: in German. Types the planner raises
      // rather than the scanner have no guide yet, in any language.
      const guide = guides.byId(b.guideId);
      if (guide) expect(guideLocales(guide), b.guideId).toContain('de');
    }
    expect(table.bindings.filter((b) => guides.byId(b.guideId)).length).toBeGreaterThanOrEqual(20);
  });

  it('every guide, every remedy the German case can show, every duty and every web message reads in German', () => {
    for (const g of guides.guides)
      for (const text of walkTexts(g)) {
        const l = de(text);
        expect(l.fellBack, `${g.id}: ${text['en']}`).toBe(false);
        expect(l.value, g.id).not.toMatch(DANISH);
      }
    for (const entry of catalogue.entries) {
      const r = entry.remedy;
      const forGermany = r.jurisdictions === 'all' || r.jurisdictions.includes('DE');
      if (!forGermany) continue;
      for (const text of walkTexts(r)) {
        const l = de(text);
        expect(l.fellBack, `${r.id}: ${text['en']}`).toBe(false);
        expect(l.value, r.id).not.toMatch(DANISH);
      }
    }
    const duties = evaluate(sets, {
      caseId,
      jurisdiction: 'DE',
      facts: {
        'company.country': 'DE',
        'company.inEea': true,
        'register.rows': 2,
        'company.headcountMin': 25,
      },
    });
    expect(duties.length).toBeGreaterThan(30);
    for (const d of duties) {
      const l = de(d.title);
      expect(l.fellBack, d.ruleId).toBe(false);
      expect(l.value, d.ruleId).not.toMatch(DANISH);
      expect(d.jurisdiction).toBe('DE');
    }
    expect(duties.some((d) => d.ruleId === 'de-authority-named')).toBe(true);
    expect(
      duties.some((d) => d.ruleId.startsWith('dk-') || d.ruleId === 'cpr-number-handling'),
    ).toBe(false);
    const messages = JSON.parse(
      readFileSync(join(I04_ROOT, 'apps', 'web', 'content', 'messages.json'), 'utf8'),
    ) as Record<string, Record<string, string>>;
    for (const [key, text] of Object.entries(messages)) {
      const l = de(text);
      expect(l.fellBack, key).toBe(false);
      expect(l.value, key).not.toMatch(DANISH);
    }
  });

  it('the German case’s own record reads in German, and names no Danish authority', async () => {
    const events = await withTenant(t, tenantId, (db) => caseTimeline(db, caseId));
    const model = timelineModel(caseId, events, { locale: 'de' });
    expect(model.entries.length).toBeGreaterThan(0);
    for (const e of model.entries) {
      expect(e.fellBack, e.type).toBe(false);
      expect(`${e.text} ${e.detail}`, e.type).not.toMatch(DANISH);
    }
    expect(model.disclaimer).not.toMatch(DANISH);
    expect(model.locale).toBe('de');
  });

  it('was content and rules only: nothing in the detectors or the UI branches on a country', () => {
    const roots = [
      join(I04_ROOT, 'packages', 'scanner', 'src'),
      join(I04_ROOT, 'packages', 'findings', 'src'),
      join(I04_ROOT, 'apps', 'web', 'app'),
      join(I04_ROOT, 'apps', 'web', 'lib'),
      join(I04_ROOT, 'apps', 'web', 'components'),
    ];
    const branch =
      /(?:jurisdiction|country)\s*(?:===|!==|==|!=)\s*['"](?:DK|DE)['"]|['"](?:DK|DE)['"]\s*(?:===|!==)\s*(?:jurisdiction|country)|case\s+['"](?:DK|DE)['"]\s*:/;
    const offenders = roots
      .flatMap((r) => sourceFiles(r))
      .filter((f) => !/[\\/]bindings\.ts$/.test(f))
      .filter((f) => branch.test(readFileSync(f, 'utf8')))
      .map((f) => relative(I04_ROOT, f).split(sep).join('/'));
    expect(offenders).toEqual([]);
  });
});
