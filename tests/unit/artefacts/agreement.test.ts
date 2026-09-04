import { describe, expect, it } from 'vitest';
import {
  AGREEMENT_CONTENT,
  agreementGaps,
  processingAgreementDocument,
  subProcessorGaps,
  subProcessorListDocument,
  tracesOf,
  withoutTraces,
  type ProcessorInput,
  type SubProcessorRow,
} from '@gc/artefacts';
import type { Company, RegisterRow } from '@gc/contracts';
import { AGREEMENT_ELEMENTS } from '@gc/findings';
import { bannedClaims, loadClaimVocabulary } from '@gc/i18n';

// The agreement and sub-processor page generators without a database (G-03): every
// element of the table becomes a clause with the element in its trace; the numbers come
// from content; gaps are named, not papered over; the pages read in three languages
// and say nothing the claim vocabulary forbids.

const vocab = loadClaimVocabulary();
const T0 = new Date('2026-09-04T09:14:00Z');
const company: Company = {
  domain: 'eksempelbutik.dk',
  legalName: 'Eksempelbutik ApS',
  country: 'DK',
  locale: 'da',
};
const contact = {
  address: 'Testvej 1, 2100 København Ø',
  email: 'privatliv@eksempelbutik.dk',
  trace: ['answer:1', 'answer:2'],
};

const row = (over: Partial<RegisterRow> = {}): RegisterRow => ({
  activityId: 'node:activity:aaaa',
  key: 'activity:newsletter',
  name: 'newsletter',
  attributes: { dataSubjects: ['customers'], retention: '2 år' },
  purposes: ['marketing'],
  dataCategories: ['contact'],
  legalBases: ['consent'],
  recipients: [{ nodeId: 'node:vendor:sendmore', name: 'Sendmore', country: 'DK' }],
  transfers: [],
  risks: [],
  controls: [],
  origin: 'answered',
  confidence: 0.9,
  evidence: [],
  draft: false,
  contradictions: 0,
  ...over,
});
const processors: ProcessorInput[] = [
  {
    nodeId: 'node:vendor:sendmore',
    key: 'vendor:host:sendmore.test',
    name: 'Sendmore',
    country: 'DK',
    activities: [row()],
  },
];
const subProcessors: SubProcessorRow[] = [
  {
    nodeId: 'node:vendor:alpha',
    name: 'Alpha Hosting GmbH',
    country: 'DE',
    engagedBy: {
      nodeId: 'node:vendor:sendmore-chain',
      name: 'Sendmore',
      key: 'vendor:host:sendmore.test',
    },
    purpose: 'Hosting',
    source: 'https://sendmore.test/legal/sub-processors',
    readOn: '2026-09-03T02:00:00Z',
    evidenceId: 'document:abc',
    level: 2,
  },
  {
    nodeId: 'node:vendor:delta',
    name: 'Delta Storage B.V.',
    engagedBy: {
      nodeId: 'node:vendor:alpha',
      name: 'Alpha Hosting GmbH',
      key: 'vendor:host:alpha-hosting.test',
    },
    source: 'https://alpha-hosting.test/sub-processors',
    readOn: '2026-09-03T02:01:00Z',
    evidenceId: 'document:def',
    level: 3,
  },
];
const input = {
  processors,
  subProcessors,
  company,
  contact,
  locale: 'en' as const,
  generatedAt: T0,
};

describe('the processing agreement', () => {
  it('writes one clause per element, in the table order, each traceable to the element and its provision', () => {
    const doc = processingAgreementDocument(input);
    expect(doc.ok).toBe(true);
    if (!doc.ok) return;
    const clauses = doc.statements.filter((s) =>
      AGREEMENT_ELEMENTS.some((e) => e.id === s.section),
    );
    expect(clauses.map((c) => c.section)).toEqual(AGREEMENT_ELEMENTS.map((e) => e.id));
    for (const e of AGREEMENT_ELEMENTS) {
      const c = clauses.find((x) => x.section === e.id)!;
      expect(c.trace[0]).toBe(`requirement:${e.id}`);
      expect(c.trace[1]).toBe(`${e.citation.instrument} ${e.citation.ref}`);
      expect(c.trace.length).toBeGreaterThan(2);
    }
    expect(tracesOf(doc.markdown)).toHaveLength(doc.statements.length);
    const shown = withoutTraces(doc.markdown);
    expect(
      shown.startsWith(`# Data processing agreement\n\n> ${AGREEMENT_CONTENT.notice['en']}`),
    ).toBe(true);
    expect(shown).toContain('Eksempelbutik ApS, Testvej 1, 2100 København Ø (the controller)');
    expect(shown).toContain(`at least ${AGREEMENT_CONTENT.defaults.noticeDays} days before`);
    expect(shown).toContain(`at the latest ${AGREEMENT_CONTENT.defaults.breachHours} hours`);
    expect(shown).toContain(`within ${AGREEMENT_CONTENT.defaults.deletionDays} days`);
    expect(shown).toContain('The record knows no transfer outside the EEA.');
    expect(shown).toContain('## Annex 1: Processors and the processing');
    expect(shown).toMatch(/\| Sendmore \| DK \| Newsletter \| .+ \| .+ \| Customers \|/);
    // Only the processors on the agreement bring their sub-processors into Annex 3.
    expect(shown).toContain(
      'Sendmore engages Alpha Hosting GmbH (DE), read from https://sendmore.test/legal/sub-processors on 2026-09-03.',
    );
    expect(shown).not.toContain('Delta Storage');
    expect(shown).toContain('## Annex 4: Standard contractual clauses');
    expect(shown).toContain('## Signatures');
    expect(shown).not.toContain('<!--');
    expect(bannedClaims(shown.split('\n---\n')[0]!, 'en', vocab)).toEqual([]);
  });

  it('names the transfers the record knows, and the security the rows answered', () => {
    const withTransfer = row({
      attributes: { dataSubjects: ['customers'], security: 'TLS and two-factor sign-in' },
      transfers: [
        {
          nodeId: 'node:transfer:1',
          vendor: 'Sendmore',
          attributes: { statement: { en: 'contracting entity in Ireland; no transfer', da: 'x' } },
        },
      ],
    });
    const doc = processingAgreementDocument({
      ...input,
      processors: [{ ...processors[0]!, activities: [withTransfer] }],
    });
    expect(doc.ok).toBe(true);
    if (!doc.ok) return;
    const shown = withoutTraces(doc.markdown);
    expect(shown).toContain(
      'The record knows these transfers: Sendmore: contracting entity in Ireland; no transfer.',
    );
    expect(shown).toContain('Newsletter: TLS and two-factor sign-in');
    const transfer = doc.statements.find((s) => s.section === 'transfer_annex')!;
    expect(transfer.trace).toContain('node:transfer:1');
  });

  it('refuses with named gaps: no processor, an unconfirmed row, no subjects, no contact', () => {
    expect(agreementGaps({ ...input, processors: [] }).map((g) => g.code)).toEqual([
      'no_processor',
    ]);
    const draft = [{ ...processors[0]!, activities: [row({ draft: true })] }];
    expect(agreementGaps({ ...input, processors: draft }).map((g) => g.code)).toEqual([
      'no_confirmed_activity',
    ]);
    const noSubjects = [{ ...processors[0]!, activities: [row({ attributes: {} })] }];
    const gaps = agreementGaps({ ...input, processors: noSubjects, contact: { trace: [] } });
    expect(gaps.map((g) => g.code)).toEqual(['no_subjects', 'no_contact']);
    expect(gaps[0]!.text).toContain('Newsletter');
    expect(gaps[0]!.activityId).toBe('node:activity:aaaa');
    const refused = processingAgreementDocument({ ...input, contact: { trace: [] } });
    expect(refused.ok).toBe(false);
  });

  it('reads in Danish and German with the same structure', () => {
    const da = processingAgreementDocument({ ...input, locale: 'da' });
    const de = processingAgreementDocument({ ...input, locale: 'de' });
    expect(da.ok && de.ok).toBe(true);
    if (!da.ok || !de.ok) return;
    expect(withoutTraces(da.markdown)).toContain('# Databehandleraftale');
    expect(withoutTraces(da.markdown)).toContain('## Bilag 3: Godkendte underdatabehandlere');
    expect(withoutTraces(de.markdown)).toContain('# Auftragsverarbeitungsvertrag');
    expect(withoutTraces(de.markdown)).toContain(
      `spätestens jedoch ${AGREEMENT_CONTENT.defaults.breachHours} Stunden`,
    );
    expect(da.statements.map((s) => s.section)).toEqual(de.statements.map((s) => s.section));
    expect(bannedClaims(withoutTraces(da.markdown).split('\n---\n')[0]!, 'da', vocab)).toEqual([]);
    expect(bannedClaims(withoutTraces(de.markdown).split('\n---\n')[0]!, 'de', vocab)).toEqual([]);
  });
});

describe('the sub-processor page', () => {
  it('lists processors, then their sub-processors with who engaged them, the day and the list', () => {
    const doc = subProcessorListDocument({
      processors,
      subProcessors,
      company,
      locale: 'en',
      generatedAt: T0,
    });
    expect(doc.ok).toBe(true);
    if (!doc.ok) return;
    const shown = withoutTraces(doc.markdown);
    expect(shown.startsWith(`# Sub-processors\n\n> ${AGREEMENT_CONTENT.notice['en']}`)).toBe(true);
    expect(shown).toContain('Generated 2026-09-04');
    expect(shown).toContain('## Processors');
    expect(shown).toContain('| Sendmore | DK | Newsletter |');
    expect(shown).toContain('## Their sub-processors');
    expect(shown).toContain(
      '| Alpha Hosting GmbH | DE | Sendmore | Hosting | 2026-09-03 | https://sendmore.test/legal/sub-processors |',
    );
    expect(shown).toContain(
      '| Delta Storage B.V. | not yet known | Alpha Hosting GmbH |  | 2026-09-03 | https://alpha-hosting.test/sub-processors |',
    );
    expect(shown).toContain(AGREEMENT_CONTENT.subprocessors.updates['en']);
    const alpha = doc.statements.find((s) => s.text.startsWith('| Alpha'))!;
    expect(alpha.trace).toEqual([
      'node:vendor:alpha',
      'node:vendor:sendmore-chain',
      'document:abc',
    ]);
    expect(bannedClaims(shown.split('\n---\n')[0]!, 'en', vocab)).toEqual([]);
  });

  it('says when no supplier list has been read, and refuses when the record names nobody', () => {
    const doc = subProcessorListDocument({
      processors,
      subProcessors: [],
      company,
      locale: 'da',
      generatedAt: T0,
    });
    expect(doc.ok && withoutTraces(doc.markdown)).toContain(
      AGREEMENT_CONTENT.subprocessors.noIndirect['da'],
    );
    expect(
      subProcessorGaps({
        processors: [],
        subProcessors: [],
        company,
        locale: 'da',
        generatedAt: T0,
      }).map((g) => g.code),
    ).toEqual(['no_vendors']);
  });
});
