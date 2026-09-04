import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReportNotVerbatim, reportModel, reportPdf, type ReportInput } from '@gc/artefacts';
import {
  CorpusDocumentSchema,
  QuotationSchema,
  excerptOf,
  parseProvisionRef,
  quotationHash,
  verbatim,
  type CorpusDocument,
  type Quotation,
} from '@gc/contracts';
import {
  assembleReport,
  confirmAgainstStore,
  corpusChunks,
  deterministicEmbedder,
  documentChunks,
  ingestCorpus,
  loadCorpusDocuments,
  quotation,
  quotationFromStore,
  quotationOf,
  scannerAreas,
} from '@gc/corpus';
import {
  createTestDatabase,
  openCase,
  schema,
  seedRemedies,
  testDatabaseUrl,
  withTenant,
  type TestDatabase,
} from '@gc/db';
import { bindingFor } from '@gc/findings';
import { loadCatalogue } from '@gc/remedies';

// Verbatim law (V-03). A quotation is fetched by identifier, from the files or from
// the store, and no model is in the path; what is about to be shown is compared with
// the entry character for character, and a shortened, dotted or annotated quotation
// fails instead of degrading; every quotation says which instrument, article and
// paragraph it is, the corpus version it came from, and the date its consolidated
// text speaks from, so an amended article is never shown as current without its date.

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
const cite = (instrument: string, ref: string) => parseProvisionRef(instrument, ref)!;
const chunks = corpusChunks();
const GDPR_28_3 = cite('GDPR', 'Art. 28(3)');

const q28 = (): Quotation => {
  const r = quotation(chunks, GDPR_28_3, 'DK');
  if (!r.ok) throw new Error(r.detail);
  return r.quotation;
};

describe('a quotation, from the files', () => {
  it('is fetched by identifier and carries instrument, article, paragraph, version and date', () => {
    const q = q28();
    expect(q).toMatchObject({
      key: 'GDPR:28:3',
      instrument: 'GDPR',
      article: '28',
      paragraph: '3',
      ref: 'GDPR Art. 28(3)',
      jurisdiction: 'EU',
      corpusVersion: '2026-09-03',
      textAsOf: '2016-05-04',
    });
    expect(q.text.startsWith('Processing by a processor shall be governed by a contract')).toBe(
      true,
    );
    expect(q.hash).toBe(quotationHash(q.key, q.text));
    expect(QuotationSchema.safeParse(q).success).toBe(true);
    // A point goes that deep, and says so.
    const p = quotation(chunks, cite('GDPR', 'Art. 28(3)(a)'), 'DE');
    expect(p.ok && p.quotation.point).toBe('a');
    expect(p.ok && p.quotation.ref).toBe('GDPR Art. 28(3)(a)');
  });

  it('is exactly the paragraph cited, in the jurisdiction it speaks in, or a failure', () => {
    expect(quotation(chunks, cite('GDPR', 'Art. 28(99)'), 'DK')).toMatchObject({
      ok: false,
      reason: 'no_such_paragraph',
    });
    const dk = chunks.find((c) => c.instrument === 'TEST-DK')!;
    const danish = cite('TEST-DK', `Art. ${dk.article}${dk.paragraph ? `(${dk.paragraph})` : ''}`);
    expect(quotation(chunks, danish, 'DE')).toMatchObject({
      ok: false,
      reason: 'wrong_jurisdiction',
    });
    expect(quotation(chunks, danish, 'DK').ok).toBe(true);
  });

  it('refuses an instrument that does not say what date its text speaks from', () => {
    const doc = loadCorpusDocuments().find((d) => d.instrument === 'TEST-REG')!;
    const { textAsOf: _dropped, ...source } = doc.source;
    void _dropped;
    const undated: CorpusDocument = CorpusDocumentSchema.parse({ ...doc, source });
    const r = quotation(documentChunks(undated), cite('TEST-REG', 'Art. 5(3)'), 'DK');
    expect(r).toMatchObject({ ok: false, reason: 'undated' });
    expect(quotationOf(documentChunks(undated)[0]!)).toMatchObject({
      ok: false,
      reason: 'undated',
    });
    // Every instrument in the corpus is dated.
    for (const d of loadCorpusDocuments())
      expect(d.source.textAsOf, d.instrument).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('a version pinned answers with its own text and its own date, never the newest', () => {
    const doc = loadCorpusDocuments().find((d) => d.instrument === 'TEST-REG')!;
    const amended: CorpusDocument = CorpusDocumentSchema.parse({
      ...doc,
      version: '2027-01-01.test',
      source: { ...doc.source, textAsOf: '2026-12-31' },
      chunks: doc.chunks.map((c) => ({ ...c, text: `${c.text} (as amended)` })),
    });
    const both = [...documentChunks(doc), ...documentChunks(amended)];
    const c = cite('TEST-REG', 'Art. 5(3)');
    const newest = quotation(both, c, 'DK');
    const pinned = quotation(both, c, 'DK', { corpusVersion: doc.version });
    expect(newest.ok && newest.quotation.textAsOf).toBe('2026-12-31');
    expect(newest.ok && newest.quotation.text.endsWith('(as amended)')).toBe(true);
    expect(pinned.ok && pinned.quotation.textAsOf).toBe(doc.source.textAsOf);
    expect(pinned.ok && pinned.quotation.corpusVersion).toBe(doc.version);
    expect(pinned.ok && pinned.quotation.text.endsWith('(as amended)')).toBe(false);
  });
});

describe('the character-for-character check', () => {
  it('passes the entry itself and nothing else', () => {
    const q = q28();
    expect(verbatim(q.text, q)).toEqual({ ok: true });
    expect(verbatim(q.text.slice(0, 80), q)).toMatchObject({ reason: 'truncated' });
    expect(verbatim(`${q.text.slice(0, 40)} … ${q.text.slice(-40)}`, q)).toMatchObject({
      reason: 'ellipsis',
    });
    expect(verbatim(`${q.text.slice(0, 40)} [...] ${q.text.slice(-40)}`, q)).toMatchObject({
      reason: 'ellipsis',
    });
    expect(verbatim(`${q.text} [emphasis added]`, q)).toMatchObject({ reason: 'annotation' });
    expect(verbatim(q.text.replace('processor', 'controller'), q)).toMatchObject({
      reason: 'differs',
      at: q.text.indexOf('processor'),
    });
    // A quote mark swapped for a curly one, or a space folded, is a difference too.
    expect(verbatim(q.text.replace(/  +/g, ' ').replace(' ', '  '), q)).toMatchObject({
      reason: 'differs',
    });
    expect(verbatim(q.text.replace(/'/g, '’'), q).ok).toBe(q.text.includes("'") === false);
  });

  it('an entry whose text was altered after it was cut is not an entry', () => {
    const q = q28();
    const altered = { ...q, text: `${q.text} ` };
    expect(verbatim(altered.text, altered)).toMatchObject({ reason: 'hash' });
    expect(excerptOf(altered, 'contract')).toMatchObject({ reason: 'hash' });
  });

  it('a span quoted from the paragraph is contiguous and verbatim, and is placed, not shown alone', () => {
    const q = q28();
    const span = 'governed by a contract or other legal act';
    const e = excerptOf(q, span);
    expect(e.ok).toBe(true);
    if (e.ok) expect(q.text.slice(e.start, e.end)).toBe(span);
    expect(excerptOf(q, 'governed by a contract … legal act')).toMatchObject({
      reason: 'ellipsis',
    });
    expect(excerptOf(q, 'governed by a [written] contract')).toMatchObject({
      reason: 'annotation',
    });
    expect(excerptOf(q, 'governed by a treaty')).toMatchObject({ reason: 'differs' });
    expect(excerptOf(q, '')).toMatchObject({ reason: 'differs' });
  });
});

describe.skipIf(!url)('a quotation, from the store', () => {
  let t: TestDatabase;
  let tenantId = '';
  let caseId = '';
  const catalogue = loadCatalogue();

  beforeAll(async () => {
    t = await createTestDatabase(url);
    for (const d of loadCorpusDocuments()) await ingestCorpus(t, d, deterministicEmbedder());
    await seedRemedies(t, catalogue);
    const opened = await openCase(t, {
      company: { domain: 'eksempelbutik.dk', country: 'DK', locale: 'da' },
      jurisdiction: 'DK',
      locale: 'da',
      now: () => T0,
    });
    tenantId = opened.tenantId;
    caseId = opened.caseId;
    await withTenant(t, tenantId, (db) =>
      db.insert(schema.findings).values({
        id: 'finding-1',
        tenantId,
        sourceRef: 'test',
        caseId,
        typeId: 'DPA-01',
        fingerprint: 'DPA-01|x',
        jurisdiction: 'DK',
        binding: bindingFor('DPA-01', 'DK'),
        severity: 'serious',
        status: 'open',
        area: 'Contracts',
        remedyId: 'dpa-01-processing-agreement',
        remedyVersion: catalogue.get('dpa-01-processing-agreement')!.remedy.version,
        firstSeenAt: T0,
        lastSeenAt: T0,
      }),
    );
  }, 120_000);

  afterAll(async () => {
    await t?.drop();
  });

  it('is the same paragraph the files hold, dated, and confirms against the store', async () => {
    const fromFiles = q28();
    const r = await quotationFromStore(t, GDPR_28_3, 'DK');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.quotation).toEqual(fromFiles);
    expect(await confirmAgainstStore(t, fromFiles)).toEqual({ ok: true });
  });

  it('a store row that no longer says what the quotation says is caught before display', async () => {
    const q = q28();
    // The row is found by hash and key; its text differs from the quotation in hand.
    const rows = await t.db
      .select()
      .from(schema.corpusChunks)
      .where(eq(schema.corpusChunks.hash, q.hash));
    const row = rows.find((x) => x.key === q.key)!;
    await t.db
      .update(schema.corpusChunks)
      .set({ text: q.text.replace('processor', 'controller') })
      .where(eq(schema.corpusChunks.id, row.id));
    expect(await confirmAgainstStore(t, q)).toMatchObject({ ok: false, reason: 'hash' });
    await t.db
      .update(schema.corpusChunks)
      .set({ text: q.text })
      .where(eq(schema.corpusChunks.id, row.id));
    expect(await confirmAgainstStore(t, q)).toEqual({ ok: true });
    // A quotation the store never held is not confirmed either.
    expect(await confirmAgainstStore(t, { ...q, hash: 'f'.repeat(64) })).toMatchObject({
      ok: false,
      reason: 'hash',
    });
  });

  it('the report quotes the corpus and nothing else, and says the date of every text', async () => {
    const input = await assembleReport(t, tenantId, caseId, {
      catalogue,
      locale: 'en',
      caseUrl: 'https://app.test/en/c/x',
      now: T0,
    });
    expect(input.articles.length).toBeGreaterThan(0);
    for (const a of input.articles) {
      expect(a.textAsOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(a.quotation.key).toBe(a.key);
      expect(verbatim(a.text, a.quotation)).toEqual({ ok: true });
      expect(await confirmAgainstStore(t, a.quotation)).toEqual({ ok: true });
    }
    const model = reportModel(input, { locale: 'en' });
    expect(model.articles.every((a) => a.asOfLabel.includes(a.textAsOf))).toBe(true);
    const pdf = await reportPdf(model);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');

    // A shortened, dotted or edited article stops the report rather than printing.
    const first = input.articles[0]!;
    const touched = (text: string): ReportInput => ({
      ...input,
      articles: [{ ...first, text }, ...input.articles.slice(1)],
    });
    expect(() => reportModel(touched(first.text.slice(0, 50)), { locale: 'en' })).toThrow(
      ReportNotVerbatim,
    );
    expect(() =>
      reportModel(touched(`${first.text.slice(0, 30)} … ${first.text.slice(-30)}`), {
        locale: 'en',
      }),
    ).toThrow(/ellipsis/);
    expect(() => reportModel(touched(`${first.text} [sic]`), { locale: 'en' })).toThrow(
      /annotation/,
    );
    await expect(
      reportPdf({ ...model, articles: [{ ...model.articles[0]!, text: `${first.text}.` }] }),
    ).rejects.toThrow(ReportNotVerbatim);
    void scannerAreas;
  });
});
