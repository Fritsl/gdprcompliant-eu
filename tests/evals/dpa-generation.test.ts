import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AGREEMENT_CONTENT, tracesOf, withoutTraces } from '@gc/artefacts';
import {
  VendorSchema,
  parseProvisionRef,
  sha256,
  type SupplyChain,
  type Vendor,
} from '@gc/contracts';
import { documentChunks, loadCorpusDocuments, resolveInChunks } from '@gc/corpus';
import {
  CONTACT_QUESTIONS,
  confirmRegisterRow,
  createTestDatabase,
  documentGaps,
  draftDocument,
  generateDocument,
  graphOf,
  openCase,
  recordAnswer,
  registerRows,
  schema,
  seedRegister,
  seedSupplyChain,
  testDatabaseUrl,
  withTenant,
  type TestDatabase,
} from '@gc/db';
import { AGREEMENT_ELEMENTS } from '@gc/findings';
import { bannedClaims, loadClaimVocabulary } from '@gc/i18n';

// DPA generation (G-03): a processing agreement and a sub-processor page written from
// the graph. The agreement has one clause per element of the table a supplier's
// agreement is read against (D-06), each traceable to the element and the provision it
// rests on, and every provision resolves in the corpus; the sub-processor page is the
// supply chain the walk read (D-07), row by row with the list and the day, and a new
// reading gives a new version; both carry the notice that a lawyer reads them first;
// a record with gaps gets a refusal that names them.

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
const vocab = loadClaimVocabulary();
const chunks = loadCorpusDocuments().flatMap(documentChunks);
const mette = { kind: 'person' as const, userId: 'u-mette', name: 'Mette' };
const LIST_URL = 'https://sendmore.test/legal/sub-processors';
const listBody = (j: 'DK' | 'DE') => `sub-processor list of Sendmore, read for ${j}`;
const listEvidenceFor = (j: 'DK' | 'DE') => {
  const hash = sha256(listBody(j));
  return { evidenceId: `document:${hash.slice(0, 16)}`, hash };
};

// The chain the walk (D-07) would have read from the mail supplier: two companies on its
// list, one of which publishes a list of its own.
function chain(j: 'DK' | 'DE', extra = false): SupplyChain {
  const listEvidence = listEvidenceFor(j);
  const document = { url: LIST_URL, fetchedAt: '2026-09-03T02:00:00Z', evidence: listEvidence };
  const alphaDoc = {
    url: 'https://alpha-hosting.test/sub-processors',
    fetchedAt: '2026-09-03T02:01:00Z',
    evidence: listEvidence,
  };
  const nodes = [
    {
      id: 'sendmore.test',
      name: 'Sendmore',
      host: 'sendmore.test',
      depth: 0,
      list: 'read' as const,
    },
    {
      id: 'alpha-hosting.test',
      name: 'Alpha Hosting GmbH',
      host: 'alpha-hosting.test',
      country: 'DE',
      depth: 1,
      list: 'read' as const,
    },
    {
      id: 'name:gamma-analytics-aps',
      name: 'Gamma Analytics ApS',
      country: 'DK',
      depth: 1,
      list: 'skipped' as const,
      skipped: 'no_site' as const,
    },
    {
      id: 'delta-storage.test',
      name: 'Delta Storage B.V.',
      host: 'delta-storage.test',
      country: 'NL',
      depth: 2,
      list: 'skipped' as const,
      skipped: 'depth' as const,
    },
    ...(extra
      ? [
          {
            id: 'beta-mail.test',
            name: 'Beta Mail Inc.',
            host: 'beta-mail.test',
            country: 'US',
            depth: 1,
            list: 'skipped' as const,
            skipped: 'no_list' as const,
          },
        ]
      : []),
  ];
  const edges = [
    {
      from: 'sendmore.test',
      to: 'alpha-hosting.test',
      document,
      entry: {
        name: 'Alpha Hosting GmbH',
        host: 'alpha-hosting.test',
        country: 'DE',
        purpose: 'Hosting',
        quote: 'Alpha Hosting GmbH\tGermany\tHosting\talpha-hosting.test',
      },
      cycle: false,
    },
    {
      from: 'sendmore.test',
      to: 'name:gamma-analytics-aps',
      document,
      entry: {
        name: 'Gamma Analytics ApS',
        country: 'DK',
        purpose: 'Product analytics',
        quote: 'Gamma Analytics ApS\tDenmark\tProduct analytics',
      },
      cycle: false,
    },
    {
      from: 'alpha-hosting.test',
      to: 'delta-storage.test',
      document: alphaDoc,
      entry: {
        name: 'Delta Storage B.V.',
        host: 'delta-storage.test',
        country: 'NL',
        purpose: 'Object storage',
        quote: 'Delta Storage B.V.\tNetherlands\tObject storage\tdelta-storage.test',
      },
      cycle: false,
    },
    {
      from: 'alpha-hosting.test',
      to: 'sendmore.test',
      document: alphaDoc,
      entry: {
        name: 'Sendmore ApS',
        host: 'sendmore.test',
        country: 'DK',
        quote: 'Sendmore ApS\tDenmark\tsendmore.test',
      },
      cycle: true,
    },
    ...(extra
      ? [
          {
            from: 'sendmore.test',
            to: 'beta-mail.test',
            document: { ...document, fetchedAt: '2026-09-10T02:00:00Z' },
            entry: {
              name: 'Beta Mail Inc.',
              host: 'beta-mail.test',
              country: 'US',
              purpose: 'Email delivery',
              quote: 'Beta Mail Inc.\tUnited States\tEmail delivery\tbeta-mail.test',
            },
            cycle: false,
          },
        ]
      : []),
  ];
  return {
    root: 'sendmore.test',
    startedAt: '2026-09-03T02:00:00Z',
    finishedAt: '2026-09-03T02:05:00Z',
    limits: { maxDepth: 2, maxNodes: 25, minIntervalMs: 2000, respectRobots: true },
    nodes,
    edges,
    stoppedBy: 'depth',
    dropped: 0,
    requests: [],
  };
}

describe.skipIf(!url)('DPA generation (G-03)', () => {
  let t: TestDatabase;
  const cases: Record<'DK' | 'DE', { tenantId: string; caseId: string }> = {
    DK: { tenantId: '', caseId: '' },
    DE: { tenantId: '', caseId: '' },
  };

  // A case whose register names one supplier (the mail platform), read from DNS, and
  // whose supply chain the walk has written to the graph.
  async function seed(jurisdiction: 'DK' | 'DE') {
    const locale = jurisdiction === 'DK' ? 'da' : 'de';
    const domain = jurisdiction === 'DK' ? 'eksempelbutik.dk' : 'beispielshop.de';
    const opened = await openCase(t, {
      company: {
        domain,
        legalName: jurisdiction === 'DK' ? 'Eksempelbutik ApS' : 'Beispielshop GmbH',
        country: jurisdiction,
        locale,
      },
      jurisdiction,
      locale,
      now: () => T0,
    });
    const { tenantId, caseId } = opened;
    const body = `MX ${domain} -> mx.sendmore.test`;
    const hash = sha256(body);
    const evidenceRef = { evidenceId: `registry_record:${hash.slice(0, 16)}`, hash };
    await withTenant(t, tenantId, (db) =>
      db.insert(schema.evidence).values([
        {
          id: evidenceRef.evidenceId,
          tenantId,
          sourceRef: 'dns',
          caseId,
          kind: 'registry_record',
          capturedAt: T0,
          body,
          hash,
          caption: 'MX record',
        },
        {
          id: listEvidenceFor(jurisdiction).evidenceId,
          tenantId,
          sourceRef: 'scanner:scan-1',
          caseId,
          kind: 'document',
          capturedAt: T0,
          body: listBody(jurisdiction),
          hash: listEvidenceFor(jurisdiction).hash,
          caption: 'sub-processor list of Sendmore',
        },
      ]),
    );
    const vendor: Vendor = VendorSchema.parse({
      id: 'host:sendmore.test',
      tenantId,
      caseId,
      label: 'Sendmore (email)',
      jurisdiction: 'DK',
      role: 'processor',
      level: 1,
      hosts: ['sendmore.test'],
      resolution: 'unresolved',
      provenance: { source: 'observation', seenAt: T0.toISOString(), evidence: [evidenceRef] },
    });
    await seedRegister(t, tenantId, caseId, { scanId: 'scan-1', now: T0, vendors: [vendor] });
    await seedSupplyChain(t, tenantId, caseId, {
      chain: chain(jurisdiction),
      scanId: 'scan-1',
      now: T0,
    });
    cases[jurisdiction] = { tenantId, caseId };
  }

  beforeAll(async () => {
    t = await createTestDatabase(url);
    await seed('DK');
    await seed('DE');
  });
  afterAll(async () => {
    await t?.drop();
  });

  it('refuses while the register names no confirmed processor, and names the gaps', async () => {
    const { tenantId, caseId } = cases.DK;
    const gaps = await documentGaps(t, tenantId, caseId, 'processing_agreement', { now: T0 });
    expect(gaps.map((g) => g.code)).toEqual(['no_processor', 'no_contact']);
    expect(gaps.every((g) => g.text.length > 10)).toBe(true);
    const refused = await generateDocument(t, tenantId, {
      caseId,
      kind: 'processing_agreement',
      by: mette,
      now: T0,
    });
    expect(refused.ok).toBe(false);
    expect(await withTenant(t, tenantId, (db) => db.select().from(schema.artefacts))).toEqual([]);
  });

  it('writes one clause per element of the Article 28 table, each traceable to the element and a provision that resolves', async () => {
    const { tenantId, caseId } = cases.DK;
    const [row] = await registerRows(t, tenantId, caseId);
    expect(row?.recipients.map((r) => r.name)).toEqual(['Sendmore (email)']);
    await confirmRegisterRow(t, tenantId, {
      caseId,
      activityId: row!.activityId,
      answerId: 'Q-email',
      by: 'Mette',
      at: new Date(T0.getTime() + 60_000),
      corrections: {
        dataSubjects: ['customers'],
        retention: '2 år efter sidste kontakt',
        security: 'Kryptering under transport, tofaktorlogin',
      },
    });
    const missingSubjectsOnly = await documentGaps(t, tenantId, caseId, 'processing_agreement', {
      now: T0,
    });
    expect(missingSubjectsOnly.map((g) => g.code)).toEqual(['no_contact']);
    await recordAnswer(t, tenantId, {
      caseId,
      questionId: CONTACT_QUESTIONS.address,
      answer: 'Testvej 1, 2100 København Ø',
      by: mette,
      at: T0,
    });
    await recordAnswer(t, tenantId, {
      caseId,
      questionId: CONTACT_QUESTIONS.email,
      answer: 'privatliv@eksempelbutik.dk',
      by: mette,
      at: T0,
    });
    expect(await documentGaps(t, tenantId, caseId, 'processing_agreement', { now: T0 })).toEqual(
      [],
    );

    const draft = await draftDocument(t, tenantId, caseId, 'processing_agreement', { now: T0 });
    expect(draft.locale).toBe('da');
    expect(draft.document.ok).toBe(true);
    if (!draft.document.ok) return;

    // Every element, exactly once, in the table's order, with the requirement in the trace.
    const clauses = draft.document.statements.filter((s) =>
      AGREEMENT_ELEMENTS.some((e) => e.id === s.section),
    );
    expect(clauses.map((c) => c.section)).toEqual(AGREEMENT_ELEMENTS.map((e) => e.id));
    for (const e of AGREEMENT_ELEMENTS) {
      const clause = clauses.find((c) => c.section === e.id)!;
      expect(clause.trace).toContain(`requirement:${e.id}`);
      expect(clause.trace).toContain(`${e.citation.instrument} ${e.citation.ref}`);
      const citation = parseProvisionRef(e.citation.instrument, e.citation.ref)!;
      const r = resolveInChunks(chunks, citation, 'DK');
      expect(r.ok, `${e.id}: ${!r.ok ? r.detail : ''}`).toBe(true);
      expect(clause.text.length).toBeGreaterThan(40);
    }

    // Every trace names something the case holds, the content, or a requirement.
    const g = await withTenant(t, tenantId, (db) => graphOf(db, caseId));
    const known = new Set([
      ...g.nodes.map((n) => n.id),
      `answer:${caseId}:${CONTACT_QUESTIONS.address}`,
      `answer:${caseId}:${CONTACT_QUESTIONS.email}`,
      listEvidenceFor('DK').evidenceId,
      'case:company',
      'content:notice',
      'content:defaults',
      'content:annex',
    ]);
    for (const s of draft.document.statements) {
      expect(s.trace.length, s.text).toBeGreaterThan(0);
      for (const ref of s.trace) {
        const ok = known.has(ref) || ref.startsWith('requirement:') || /^GDPR Art\. \d+/.test(ref);
        expect(ok, `${s.section}: ${ref}`).toBe(true);
      }
    }
    expect(tracesOf(draft.document.markdown)).toHaveLength(draft.document.statements.length);

    // What a reader sees: the notice first, the company, the numbers from content, the
    // sub-processors the walk read with where they were read, and no forbidden claim.
    const shown = withoutTraces(draft.document.markdown);
    expect(shown.startsWith('# Databehandleraftale\n\n> ')).toBe(true);
    expect(shown).toContain(AGREEMENT_CONTENT.notice['da']);
    expect(shown).toContain('Eksempelbutik ApS, Testvej 1, 2100 København Ø');
    expect(shown).toContain(`${AGREEMENT_CONTENT.defaults.breachHours} timer`);
    expect(shown).toContain(`${AGREEMENT_CONTENT.defaults.noticeDays} dage`);
    expect(shown).toContain('| Sendmore (email) |');
    expect(shown).toContain('Kryptering under transport, tofaktorlogin');
    expect(shown).toContain(
      `Sendmore anvender Alpha Hosting GmbH (DE), læst fra ${LIST_URL} den 2026-09-03.`,
    );
    expect(shown).toContain('Gamma Analytics ApS (DK)');
    expect(shown).not.toContain('Delta Storage');
    expect(shown).toContain('## Bilag 4');
    expect(shown).not.toContain('<!--');
    expect(bannedClaims(shown.split('\n---\n')[0]!, 'da', vocab)).toEqual([]);

    const stored = await generateDocument(t, tenantId, {
      caseId,
      kind: 'processing_agreement',
      by: mette,
      now: T0,
    });
    expect(stored.ok).toBe(true);
    const rows = await withTenant(t, tenantId, (db) =>
      db
        .select()
        .from(schema.artefacts)
        .then((all) => all.filter((r) => r.kind === 'processing_agreement')),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'processing_agreement', version: 1, status: 'draft' });
    expect(rows[0]!.content).toBe(draft.document.markdown);
  });

  it('the sub-processor page lists the chain row by row with the list and the day, and a new reading is a new version', async () => {
    const { tenantId, caseId } = cases.DK;
    expect(await documentGaps(t, tenantId, caseId, 'sub_processor_list', { now: T0 })).toEqual([]);
    const first = await draftDocument(t, tenantId, caseId, 'sub_processor_list', { now: T0 });
    expect(first.document.ok).toBe(true);
    if (!first.document.ok) return;
    const shown = withoutTraces(first.document.markdown);
    expect(shown.startsWith('# Underdatabehandlere\n\n> ')).toBe(true);
    expect(shown).toContain(AGREEMENT_CONTENT.notice['da']);
    expect(shown).toContain('## Databehandlere');
    expect(shown).toMatch(/\| Sendmore \(email\) \| DK \| .+ \|/);
    expect(shown).toContain('## Deres underdatabehandlere');
    expect(shown).toContain(
      `| Alpha Hosting GmbH | DE | Sendmore | Hosting | 2026-09-03 | ${LIST_URL} |`,
    );
    expect(shown).toContain(
      '| Delta Storage B.V. | NL | Alpha Hosting GmbH | Object storage | 2026-09-03 | https://alpha-hosting.test/sub-processors |',
    );
    expect(shown).toContain('| Gamma Analytics ApS | DK | Sendmore | Product analytics |');
    // A cycle is never a row: the supplier is not its own sub-processor.
    expect(shown).not.toContain('| Sendmore ApS |');
    expect(shown).toContain(AGREEMENT_CONTENT.subprocessors.updates['da']);
    expect(bannedClaims(shown.split('\n---\n')[0]!, 'da', vocab)).toEqual([]);
    for (const s of first.document.statements) expect(s.trace.length).toBeGreaterThan(0);

    const v1 = await generateDocument(t, tenantId, {
      caseId,
      kind: 'sub_processor_list',
      by: mette,
      now: T0,
    });
    expect(v1.ok && v1.artefact.version).toBe(1);

    // The walk reads the list again a week later and finds a new name.
    await seedSupplyChain(t, tenantId, caseId, {
      chain: chain('DK', true),
      scanId: 'scan-2',
      now: new Date('2026-09-10T02:00:00Z'),
    });
    const later = new Date('2026-09-10T09:00:00Z');
    const v2 = await generateDocument(t, tenantId, {
      caseId,
      kind: 'sub_processor_list',
      by: mette,
      now: later,
    });
    expect(v2.ok && v2.artefact.version).toBe(2);
    const rows = await withTenant(t, tenantId, (db) =>
      db
        .select()
        .from(schema.artefacts)
        .then((all) => all.filter((r) => r.kind === 'sub_processor_list')),
    );
    expect(rows).toHaveLength(1);
    const updated = withoutTraces(rows[0]!.content);
    expect(updated).toContain('| Beta Mail Inc. | US | Sendmore | Email delivery | 2026-09-10 |');
    expect(updated).toContain('| Alpha Hosting GmbH | DE | Sendmore |');
    expect(updated).toContain('Udarbejdet 2026-09-10');
  });

  it('a German case reads in German, structured the same, and a case with no supplier is refused', async () => {
    const { tenantId, caseId } = cases.DE;
    const [row] = await registerRows(t, tenantId, caseId);
    await confirmRegisterRow(t, tenantId, {
      caseId,
      activityId: row!.activityId,
      answerId: 'Q-email',
      by: 'Jonas',
      at: new Date(T0.getTime() + 60_000),
      corrections: { dataSubjects: ['customers'] },
    });
    for (const [questionId, answer] of [
      [CONTACT_QUESTIONS.address, 'Musterstraße 1, 10115 Berlin'],
      [CONTACT_QUESTIONS.email, 'datenschutz@beispielshop.de'],
    ] as const) {
      await recordAnswer(t, tenantId, { caseId, questionId, answer, by: mette, at: T0 });
    }
    const draft = await draftDocument(t, tenantId, caseId, 'processing_agreement', { now: T0 });
    expect(draft.locale).toBe('de');
    expect(draft.document.ok).toBe(true);
    if (!draft.document.ok) return;
    const shown = withoutTraces(draft.document.markdown);
    expect(shown).toContain('# Auftragsverarbeitungsvertrag');
    expect(shown).toContain('Beispielshop GmbH, Musterstraße 1, 10115 Berlin');
    expect(shown).toContain('## Anlage 1');
    expect(shown).toContain(AGREEMENT_CONTENT.notice['de']);
    expect(bannedClaims(shown.split('\n---\n')[0]!, 'de', vocab)).toEqual([]);
    const sectionsDe = [...new Set(draft.document.statements.map((s) => s.section))];
    const da = await draftDocument(t, cases.DK.tenantId, cases.DK.caseId, 'processing_agreement', {
      now: T0,
    });
    expect(da.document.ok && [...new Set(da.document.statements.map((s) => s.section))]).toEqual(
      sectionsDe,
    );

    const empty = await openCase(t, {
      company: { domain: 'tom.dk', country: 'DK', locale: 'da' },
      jurisdiction: 'DK',
      locale: 'da',
      now: () => T0,
    });
    const gaps = await documentGaps(t, empty.tenantId, empty.caseId, 'sub_processor_list', {
      now: T0,
    });
    expect(gaps.map((g) => g.code)).toEqual(['no_vendors']);
  });
});
