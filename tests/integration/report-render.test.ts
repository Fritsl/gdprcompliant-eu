import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reportModel, reportPdf, type ReportInput } from '@gc/artefacts';
import { FINDING_AREAS, type Citation } from '@gc/contracts';
import {
  ReportCitationUnresolved,
  assembleReport,
  documentChunks,
  loadCorpusDocuments,
  resolveInChunks,
  scannerAreas,
} from '@gc/corpus';
import {
  appendCaseEvent,
  createTestDatabase,
  inviteMember,
  joinByInvite,
  openCase,
  schema,
  seedRemedies,
  testDatabaseUrl,
  withTenant,
  type TestDatabase,
} from '@gc/db';
import { bindingFor } from '@gc/findings';
import { loadCatalogue } from '@gc/remedies';

// The status report (V-01), rendered from a case mid-progress: a matrix in which "not
// determined" is its own state and never a pass, numbered actions in the plan's order
// with owner and effort, every provision quoted in full from the corpus, the same
// document twice for the same moment, greyscale ink only, and the live address on it.

const url = testDatabaseUrl();
const T0 = new Date('2026-08-20T09:00:00Z');
const T1 = new Date('2026-08-27T09:00:00Z');
const NOW = new Date('2026-09-04T12:30:00Z');
const CASE_URL = 'https://app.test/en/c/abc123';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const pdfText = (pdf: Buffer): string =>
  pdf
    .toString('latin1')
    .replace(/>\s*-?\d+(?:\.\d+)?\s*(?=<|\])/g, '>')
    .replace(/<([0-9a-fA-F]+)>/g, (_, h: string) => Buffer.from(h, 'hex').toString('latin1'));

const FINDINGS = [
  {
    id: 'f-hsts',
    type: 'SEC-03',
    remedy: 'sec-03-hsts',
    area: 'Security',
    severity: 'serious',
    status: 'closed',
  },
  {
    id: 'f-ref',
    type: 'SEC-05',
    remedy: 'sec-05-referrer-policy',
    area: 'Security',
    severity: 'advisory',
    status: 'open',
  },
  {
    id: 'f-tags',
    type: 'CNS-02',
    remedy: 'cns-02-gate-tags',
    area: 'Consent',
    severity: 'blocking',
    status: 'closed',
  },
  {
    id: 'f-cns1',
    type: 'CNS-01',
    remedy: 'cns-01-gate-before-interaction',
    area: 'Consent',
    severity: 'blocking',
    status: 'open',
  },
  {
    id: 'f-tick',
    type: 'FRM-01',
    remedy: 'frm-01-untick-the-box',
    area: 'Collection',
    severity: 'serious',
    status: 'regressed',
  },
] as const;

describe.skipIf(!url)('the status report (V-01)', () => {
  let t: TestDatabase;
  let tenantId = '';
  let caseId = '';
  const catalogue = loadCatalogue();
  const chunks = loadCorpusDocuments().flatMap((d) => documentChunks(d));
  const opts = { catalogue, locale: 'en' as const, caseUrl: CASE_URL, now: NOW };

  beforeAll(async () => {
    t = await createTestDatabase(url);
    await seedRemedies(t, catalogue);
    const opened = await openCase(t, {
      company: {
        domain: 'eksempelbutik.dk',
        legalName: 'Eksempelbutik ApS',
        country: 'DK',
        locale: 'da',
      },
      jurisdiction: 'DK',
      locale: 'da',
    });
    tenantId = opened.tenantId;
    caseId = opened.caseId;
    for (const f of FINDINGS) {
      await withTenant(t, tenantId, (db) =>
        db.insert(schema.findings).values({
          id: f.id,
          tenantId,
          sourceRef: 'test',
          caseId,
          typeId: f.type,
          fingerprint: `${f.type}|x`,
          jurisdiction: 'DK',
          binding: bindingFor(f.type, 'DK'),
          severity: f.severity,
          status: f.status,
          area: f.area,
          remedyId: f.remedy,
          remedyVersion: catalogue.get(f.remedy)!.remedy.version,
          firstSeenAt: T0,
          lastSeenAt: T1,
          ...(f.status === 'closed' ? { closedAt: T1 } : {}),
        }),
      );
    }
    await withTenant(t, tenantId, async (db) => {
      await appendCaseEvent(db, {
        tenantId,
        caseId,
        at: T1,
        actor: { kind: 'scanner' },
        type: 'scan_completed',
        payload: { scanId: 'scan-1', checksRun: 12, checksPassed: 8, findings: 5, undetermined: 1 },
      });
      await appendCaseEvent(db, {
        tenantId,
        caseId,
        at: T1,
        actor: { kind: 'scanner' },
        type: 'check_undetermined',
        payload: { typeId: 'VND-11', reason: 'One third-party host could not be identified' },
      });
    });
    // Lars has joined for IT; nobody for marketing.
    const invite = await inviteMember(t, {
      caseId,
      tenantId,
      role: 'it',
      email: 'lars@eksempelbutik.dk',
      invitedBy: 'Mette',
      baseUrl: 'https://app.test',
      locale: 'en',
      now: () => T1,
    });
    await joinByInvite(t, invite.inviteToken);
  });

  afterAll(async () => {
    await t?.drop();
  });

  it('a matrix by area where not determined is its own state and never a pass', async () => {
    const input = await assembleReport(t, tenantId, caseId, opts);
    const model = reportModel(input, { locale: 'en' });
    const row = (area: string) => model.matrix.find((r) => r.area === area)!;
    expect(model.matrix.map((r) => r.area)).toEqual([...FINDING_AREAS]);
    expect(row('Security')).toMatchObject({
      state: 'open',
      stateLabel: 'Open',
      note: '1 open: SEC-05',
    });
    expect(row('Consent')).toMatchObject({ state: 'open', note: '1 open: CNS-01' });
    expect(row('Collection')).toMatchObject({ state: 'open', note: '1 open: FRM-01' });
    expect(row('Recipients')).toMatchObject({
      state: 'undetermined',
      stateLabel: 'Not determined',
      note: 'One third-party host could not be identified',
    });
    // An area the scanner can see, scanned, with nothing found, is in order; an area it
    // cannot see from outside is not determined, however clean it looks.
    const covered = scannerAreas();
    for (const r of model.matrix) {
      const findings = input.findings.filter((f) => f.area === r.area);
      if (findings.length > 0 || r.area === 'Recipients') continue;
      if (covered.includes(r.area))
        expect(r).toMatchObject({ state: 'done', note: 'Checked, nothing found' });
      else expect(r).toMatchObject({ state: 'undetermined', note: 'Not checked from outside' });
    }
    expect(
      model.matrix.some((r) => r.state === 'undetermined' && r.note === 'Not checked from outside'),
    ).toBe(true);
    expect(model.summary).toBe(
      `2 of 5 findings closed. 3 areas open, ${model.matrix.filter((r) => r.state === 'undetermined').length} not determined from outside.`,
    );
  });

  it('numbered actions in the plan order, each with an owner and an effort', async () => {
    const input = await assembleReport(t, tenantId, caseId, opts);
    const model = reportModel(input, { locale: 'en' });
    expect(model.actions.map((a) => [a.n, a.ref])).toEqual([
      [1, 'CNS-01'],
      [2, 'FRM-01'],
      [3, 'SEC-05'],
    ]);
    const title = (remedy: string) => catalogue.get(remedy)!.remedy.title.en;
    expect(model.actions[0]).toMatchObject({
      what: title('cns-01-gate-before-interaction'),
      who: 'Marketing',
    });
    expect(model.actions[2]).toMatchObject({
      what: title('sec-05-referrer-policy'),
      who: 'IT · lars@eksempelbutik.dk',
      effort: catalogue.get('sec-05-referrer-policy')!.remedy.effort.label.en,
    });
    for (const a of model.actions) expect(a.effort.length).toBeGreaterThan(0);
  });

  it('quotes every provision the findings rest on, in full, from the corpus, and refuses one it cannot resolve', async () => {
    const input = await assembleReport(t, tenantId, caseId, opts);
    const cited = new Set(
      input.findings
        .flatMap((f) => f.citations.filter((c) => c.kind === 'provision'))
        .map((c) => `${c.instrument} ${c.ref}`),
    );
    expect(cited.size).toBeGreaterThan(0);
    expect(new Set(input.articles.map((a) => a.reference))).toEqual(cited);
    for (const a of input.articles) {
      const c = input.findings
        .flatMap((f) => f.citations)
        .find(
          (x): x is Extract<Citation, { kind: 'provision' }> =>
            x.kind === 'provision' && `${x.instrument} ${x.ref}` === a.reference,
        )!;
      const r = resolveInChunks(chunks, c, 'DK');
      expect(r.ok).toBe(true);
      if (r.ok && 'chunk' in r) {
        expect(a.text).toBe(r.chunk.text);
        expect(a.text.length).toBeGreaterThan(80);
        expect(a.sourceUrl).toMatch(/^https:\/\//);
        expect(a.corpusVersion).toBe(r.chunk.corpusVersion);
      }
    }
    const withoutGdpr = chunks.filter((c) => c.instrument !== 'GDPR');
    await expect(
      assembleReport(t, tenantId, caseId, { ...opts, chunks: withoutGdpr }),
    ).rejects.toThrow(ReportCitationUnresolved);
  });

  it('is reproducible: the same case at the same moment is the same bytes', async () => {
    const a = await assembleReport(t, tenantId, caseId, opts);
    const b = await assembleReport(t, tenantId, caseId, opts);
    expect(b).toEqual(a);
    const one = await reportPdf(reportModel(a, { locale: 'en' }));
    const two = await reportPdf(reportModel(b, { locale: 'en' }));
    expect(sha(two)).toBe(sha(one));
    // A different moment is a different document, and says so.
    const later = await assembleReport(t, tenantId, caseId, {
      ...opts,
      now: new Date(NOW.getTime() + 60_000),
    });
    expect(sha(await reportPdf(reportModel(later, { locale: 'en' })))).not.toBe(sha(one));
  });

  it('prints in greyscale, carries the live address on every page, and reads as a report', async () => {
    const input = await assembleReport(t, tenantId, caseId, opts);
    const model = reportModel(input, { locale: 'en' });
    const pdf = await reportPdf(model, { compress: false });
    const text = pdfText(pdf);
    expect(text.startsWith('%PDF-1.')).toBe(true);
    for (const needle of [
      caseId,
      'GDPR status report',
      'Eksempelbutik ApS',
      CASE_URL,
      '4 September 2026',
      'Where things stand',
      'Not determined',
      'Not checked from outside',
      'What needs doing',
      'lars@eksempelbutik.dk',
      'Quoted in full, as written.',
      input.articles[0]!.reference,
      'not a legal opinion',
      'Page 1 of',
    ]) {
      expect(text, needle).toContain(needle);
    }
    // Ink only: every colour operator is a grey (r = g = b), so nothing is lost on paper.
    const raw = pdf.toString('latin1');
    // PDFKit sets colour as "r g b scn" in DeviceRGB; the stroke form is SCN.
    const colours = [
      ...raw.matchAll(/(-?\d*\.?\d+) (-?\d*\.?\d+) (-?\d*\.?\d+) (rg|RG|scn|SCN)\b/g),
    ];
    expect(colours.length).toBeGreaterThan(0);
    for (const m of colours) {
      expect(m[1], m[0]).toBe(m[2]);
      expect(m[2], m[0]).toBe(m[3]);
    }
    // The address is in the page footer, once per page.
    const pages = (raw.match(/\/Type \/Page\b/g) ?? []).length;
    expect(pages).toBeGreaterThanOrEqual(1);
    expect(
      (text.match(new RegExp(CASE_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length,
    ).toBeGreaterThanOrEqual(pages + 1);
  });

  it('is available at any moment: a fresh case with nothing scanned still renders, honestly', async () => {
    const fresh = await openCase(t, {
      company: { domain: 'ny.dk', country: 'DK', locale: 'da' },
      jurisdiction: 'DK',
      locale: 'da',
    });
    const input = await assembleReport(t, fresh.tenantId, fresh.caseId, { ...opts, locale: 'da' });
    const model = reportModel(input, { locale: 'da' });
    expect(model.actions).toEqual([]);
    expect(model.articles).toEqual([]);
    expect(model.matrix.every((r) => r.state === 'undetermined')).toBe(true);
    expect(model.summary).toBe('0 af 0 fund lukket. 0 områder åbne, 8 ikke afgjort udefra.');
    const pdf = await reportPdf(model, { compress: false });
    const text = pdfText(pdf);
    expect(text).toContain('GDPR-statusrapport');
    expect(text).toContain('Ikke afgjort');
    expect(text).toContain('Intet er');
    expect(text).toContain('ikke en juridisk vurdering');
  });

  it('the model is pure: the same input renders the same model, in either language', () => {
    const input: ReportInput = {
      caseId: 'DK-26-TEST',
      domain: 'x.dk',
      caseUrl: 'https://app.test/en/c/x',
      generatedAt: NOW.toISOString(),
      findings: [],
      undetermined: [],
      coveredAreas: [],
      scanned: false,
      articles: [],
      decisions: [],
    };
    const en = reportModel(input, { locale: 'en' });
    expect(en.matrix.every((r) => r.stateLabel === 'Not determined')).toBe(true);
    expect(en.generated).toBe('4 September 2026 at 14:30');
    expect(reportModel(input, { locale: 'en' })).toEqual(en);
    expect(reportModel(input, { locale: 'da' }).title).toBe('GDPR-statusrapport');
  });
});
