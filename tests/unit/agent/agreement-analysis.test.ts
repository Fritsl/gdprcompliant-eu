import { describe, expect, it } from 'vitest';
import {
  AGREEMENT_SPECIFICS,
  parseProvisionRef,
  sha256,
  type AgreementClause,
  type ModelOutput,
  type UntrustedContent,
} from '@gc/contracts';
import {
  AGREEMENT_SYSTEM_PROMPT,
  agreementClaims,
  agreementPrompt,
  analyseAgreement,
  breachWindowHours,
  checkBreachWindow,
  checkSubprocessorObjection,
  checkTransferAnnex,
  exactSpan,
} from '@gc/agent';
import { documentChunks, loadCorpusDocuments, resolveInChunks } from '@gc/corpus';
import { AGREEMENT_ELEMENTS, agreementElement } from '@gc/findings';

// Agreement analysis without a model (D-06): the element table rests on provisions that
// resolve in the corpus for both jurisdictions; the prompt asks by element id and never
// carries the document; the three specific checks read a clause the same way every
// time; the verdict follows from the clauses; and the claims carry what the gate needs.

const chunks = loadCorpusDocuments().flatMap(documentChunks);
const text = 'Databehandleren underretter Den Dataansvarlige uden ugrundet ophold.';
const document: UntrustedContent = {
  trust: 'untrusted',
  source: { description: 'processing agreement', fetchedAt: '2026-09-04T09:14:00Z' },
  mediaType: 'text/plain',
  hash: sha256(text),
  text,
};
const input = {
  document,
  documentEvidence: { evidenceId: 'document:abc', hash: sha256(text) },
  elements: AGREEMENT_ELEMENTS,
  jurisdiction: 'DK' as const,
  locale: 'da' as const,
};

const clause = (
  element: string,
  status: AgreementClause['status'],
  quote?: string,
): AgreementClause => ({
  element,
  status,
  ...(quote !== undefined ? { quote } : {}),
  citation: parseProvisionRef('GDPR', 'Art. 28(3)')!,
});
const breach = agreementElement('breach_notification')!;

describe('the element table', () => {
  it('names sixteen elements, each resting on a provision that resolves in DK and in DE', () => {
    expect(AGREEMENT_ELEMENTS).toHaveLength(16);
    for (const e of AGREEMENT_ELEMENTS) {
      const citation = parseProvisionRef(e.citation.instrument, e.citation.ref);
      expect(citation, e.id).toBeDefined();
      for (const jurisdiction of ['DK', 'DE'] as const) {
        const r = resolveInChunks(chunks, citation!, jurisdiction);
        expect(r.ok, `${e.id} ${e.citation.ref} in ${jurisdiction}: ${!r.ok ? r.detail : ''}`).toBe(
          true,
        );
      }
      expect(e.label['en']).toBeTruthy();
      expect(e.label['da']).toBeTruthy();
      expect(e.label['de']).toBeTruthy();
    }
  });

  it('carries each specific check exactly once, and the breach limit as content', () => {
    for (const s of AGREEMENT_SPECIFICS) {
      expect(AGREEMENT_ELEMENTS.filter((e) => e.specific === s)).toHaveLength(1);
    }
    expect(breach.limitHours).toBe(72);
    expect(AGREEMENT_ELEMENTS.filter((e) => e.limitHours !== undefined)).toHaveLength(1);
  });
});

describe('the prompt', () => {
  it('asks by element id, says undetermined beats a guess, and leaves the document to the client', () => {
    const p = agreementPrompt(input);
    expect(p.system).toBe(AGREEMENT_SYSTEM_PROMPT);
    expect(p.system).toMatch(/undetermined, not present/);
    expect(p.system).toMatch(/Never say whether the agreement is lawful/);
    for (const e of AGREEMENT_ELEMENTS) expect(p.user).toContain(`- ${e.id}: ${e.asks}`);
    expect(p.user).not.toContain(text);
    expect(p.user).toContain('company in DK, which is the controller');
  });
});

describe('the breach window', () => {
  it.each([
    ['within 24 hours after becoming aware', 24, false],
    ['within twenty-four hours', 24, false],
    ['within 5 business days of becoming aware', 120, true],
    ['senest 48 timer efter', 48, false],
    ['innerhalb von 36 Stunden nach Bekanntwerden', 36, false],
    ['innerhalb von 2 Werktagen', 48, true],
    ['inden for 3 dage', 72, false],
    ['without undue delay', undefined, false],
    ['will notify the Customer', undefined, false],
  ])('%s → %s hours', (quote, hours, business) => {
    const w = breachWindowHours(quote);
    if (hours === undefined) expect(w).toBeUndefined();
    else expect(w).toEqual({ hours, business });
  });

  it('passes a fixed time up to the limit or no undue delay, and fails a late or missing one', () => {
    const at = (q: string) =>
      checkBreachWindow(clause('breach_notification', 'present', q), breach);
    expect(at('within 24 hours').status).toBe('met');
    expect(at('within 72 hours').status).toBe('met');
    expect(at('without undue delay').status).toBe('met');
    expect(at('unverzüglich').status).toBe('met');
    const late = at('within 96 hours');
    expect(late.status).toBe('not_met');
    expect(late.hours).toBe(96);
    expect(late.detail).toMatch(/72 hours/);
    expect(at('within 5 business days').status).toBe('not_met');
    const silent = at('will notify the Customer of any incident');
    expect(silent.status).toBe('not_met');
    expect(silent.detail).toMatch(/names no time/);
    expect(checkBreachWindow(clause('breach_notification', 'absent'), breach).status).toBe(
      'not_met',
    );
    expect(checkBreachWindow(clause('breach_notification', 'undetermined'), breach).status).toBe(
      'undetermined',
    );
  });
});

describe('the sub-processor objection and the transfer annex', () => {
  it('objection: notice and a way to object, or not', () => {
    const at = (q: string) =>
      checkSubprocessorObjection(clause('subprocessor_objection', 'present', q));
    expect(at('gives 30 days notice and the Controller may object').status).toBe('met');
    expect(at('underretter Kunden 30 dage før og Kunden kan gøre indsigelse').status).toBe('met');
    expect(at('informiert den Verantwortlichen vorab; dieser kann widersprechen').status).toBe(
      'met',
    );
    const noticeOnly = at('will inform the Customer by updating its website');
    expect(noticeOnly.status).toBe('not_met');
    expect(noticeOnly.detail).toMatch(/no way to object/);
    expect(at('may engage sub-processors at any time').status).toBe('not_met');
    expect(checkSubprocessorObjection(clause('subprocessor_objection', 'absent')).status).toBe(
      'not_met',
    );
    expect(
      checkSubprocessorObjection(clause('subprocessor_objection', 'undetermined')).status,
    ).toBe('undetermined');
  });

  it('transfer: a named safeguard or no transfer passes, an unbacked transfer fails', () => {
    const at = (q: string) => checkTransferAnnex(clause('transfer_annex', 'present', q));
    expect(at('under the standard contractual clauses annexed as Annex 4').status).toBe('met');
    expect(at('på grundlag af EU-Kommissionens standardkontraktbestemmelser').status).toBe('met');
    expect(at('auf Grundlage der Standardvertragsklauseln').status).toBe('met');
    expect(at('is not transferred outside the European Economic Area').status).toBe('met');
    expect(at('behandles udelukkende inden for EU/EØS').status).toBe('met');
    expect(at('covered by an adequacy decision').status).toBe('met');
    const bare = at('data may be transferred to third countries');
    expect(bare.status).toBe('not_met');
    expect(bare.detail).toMatch(/annexes no safeguard/);
    expect(at('Our servers are located in the United States.').status).toBe('not_met');
    expect(checkTransferAnnex(clause('transfer_annex', 'absent')).status).toBe('not_met');
  });
});

describe('quotes', () => {
  it('are placed in the document character for character, even when the model folded whitespace', () => {
    const doc = 'The Processor\n  notifies the   Controller within 24 hours.';
    expect(exactSpan(doc, 'The Processor notifies the Controller within 24 hours.')).toBe(
      'The Processor\n  notifies the   Controller within 24 hours.',
    );
    expect(exactSpan(doc, 'notifies the Controller')).toBe('notifies the   Controller');
    expect(exactSpan(doc, 'within 4 hours')).toBeUndefined();
  });
});

// A model stub that answers what it is told, bypassing the client and its guard.
const stub = (clauses: ModelOutput<'analyse_agreement_clauses'>['clauses']) => ({
  call: async () => ({ clauses }) as never,
});
const allPresent = (quote: string) =>
  AGREEMENT_ELEMENTS.map((e) => ({ element: e.id, status: 'present' as const, quote }));

describe('the analysis', () => {
  it('is adequate only when every element is present and every check met', async () => {
    const good = 'Databehandleren underretter Den Dataansvarlige uden ugrundet ophold.';
    // The generic quote passes the breach check (no undue delay) but not the others.
    const a = await analyseAgreement(stub(allPresent(good)), input);
    expect(a.missing).toEqual([]);
    expect(a.specifics.map((s) => [s.specific, s.status])).toEqual([
      ['subprocessor_objection', 'not_met'],
      ['breach_window', 'met'],
      ['transfer_annex', 'not_met'],
    ]);
    expect(a.verdict).toBe('inadequate');
    expect(a.drafts).toEqual([
      {
        typeId: 'DPA-03',
        elements: ['subprocessor_objection', 'transfer_annex'],
        evidence: [input.documentEvidence],
      },
    ]);
  });

  it('an absent element is a finding; an undetermined one leaves the verdict open', async () => {
    const answers = allPresent(text).map((c) =>
      c.element === 'audits' ? { element: c.element, status: 'absent' as const } : c,
    );
    // Make the two other specifics pass by quoting the whole document, which the stub
    // does not check; the checks read the quote alone.
    const doc = {
      ...input,
      document: {
        ...document,
        text: `${text} Underretter Kunden 30 dage før og Kunden kan gøre indsigelse. Overføres ikke til tredjelande.`,
      },
    };
    doc.document.hash = sha256(doc.document.text);
    const withQuotes = answers.map((c) =>
      c.element === 'subprocessor_objection'
        ? { ...c, quote: 'Underretter Kunden 30 dage før og Kunden kan gøre indsigelse.' }
        : c.element === 'transfer_annex'
          ? { ...c, quote: 'Overføres ikke til tredjelande.' }
          : c,
    );
    const absent = await analyseAgreement(stub(withQuotes), doc);
    expect(absent.missing).toEqual(['audits']);
    expect(absent.verdict).toBe('inadequate');
    expect(absent.drafts[0]!.elements).toEqual(['audits']);

    const open = await analyseAgreement(
      stub(
        withQuotes.map((c) =>
          c.element === 'audits' ? { element: 'audits', status: 'undetermined' as const } : c,
        ),
      ),
      doc,
    );
    expect(open.missing).toEqual([]);
    expect(open.undetermined).toEqual(['audits']);
    expect(open.verdict).toBe('undetermined');
    expect(open.drafts).toEqual([]);

    const fine = await analyseAgreement(
      stub(
        withQuotes.map((c) =>
          c.element === 'audits' ? { ...c, status: 'present' as const, quote: text } : c,
        ),
      ),
      doc,
    );
    expect(fine.verdict).toBe('adequate');
  });

  it('a present answer whose quote is not in the document is undetermined, never present', async () => {
    const answers = allPresent(text).map((c) =>
      c.element === 'audits' ? { ...c, quote: 'The Processor allows audits at any time.' } : c,
    );
    const a = await analyseAgreement(stub(answers), input);
    expect(a.clauses.find((c) => c.element === 'audits')?.status).toBe('undetermined');
    expect(a.undetermined).toEqual(['audits']);
  });
});

describe('the claims', () => {
  it('observe what is present with the quote, and make a cited legal claim for what is not', async () => {
    const answers = allPresent(text).map((c) =>
      c.element === 'audits' ? { element: c.element, status: 'absent' as const } : c,
    );
    const a = await analyseAgreement(stub(answers), input);
    const claims = agreementClaims(a, {
      caseId: 'DK-26-0M4K',
      documentEvidence: input.documentEvidence,
      elements: AGREEMENT_ELEMENTS,
      corpusVersion: '2026-09-03',
      taskId: 'task-1',
      at: new Date('2026-09-04T09:14:00Z'),
    });
    const observations = claims.filter((c) => c.kind === 'observation');
    expect(observations).toHaveLength(15);
    for (const c of observations) {
      expect(c.evidence).toEqual([{ ...input.documentEvidence, quote: text }]);
      expect(c.citations).toEqual([]);
    }
    const legal = claims.filter((c) => c.kind === 'legal');
    // audits absent, plus the two specific checks the generic quote fails.
    expect(legal.map((c) => c.statement)).toEqual([
      expect.stringContaining(
        'does not stipulate that the processor makes available the information',
      ),
      expect.stringContaining('Notice of new sub-processors and a way to object:'),
      expect.stringContaining('Transfers outside the EEA, and the safeguard they rest on:'),
    ]);
    for (const c of legal) {
      expect(c.citations).toHaveLength(1);
      expect(c.citations[0]!.kind).toBe('provision');
      expect(c.jurisdiction).toBe('DK');
      expect(c.corpusVersion).toBe('2026-09-03');
      expect(c.producedBy.worker).toBe('agreement_reader');
    }
    expect(legal[0]!.citations[0]!.ref).toBe('Art. 28(3)(h)');
    expect(legal[1]!.citations[0]!.ref).toBe('Art. 28(2)');
    expect(legal[2]!.citations[0]!.ref).toBe('Art. 46(1)');
  });
});
