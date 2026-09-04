import { describe, expect, it } from 'vitest';
import { citationKey, sha256, type UntrustedContent } from '@gc/contracts';
import { POLICY_CLAUSES_SYSTEM_PROMPT, analysePolicyClauses, policyClausesPrompt } from '@gc/agent';
import { documentChunks, loadCorpusDocuments, resolveInChunks } from '@gc/corpus';
import { DISCLOSURE_ELEMENTS } from '@gc/findings';

// Clause analysis without a model (S-10): the disclosure table's provisions all resolve
// in the corpus for both jurisdictions the product speaks; the prompt asks by element
// id and never carries the document itself; the analysis ties every answer to the
// table's citation and finding type and treats silence as undetermined.

const chunks = loadCorpusDocuments().flatMap(documentChunks);
const text = 'Vi opbevarer dine oplysninger i fem år.';
const document: UntrustedContent = {
  trust: 'untrusted',
  source: { description: 'privacy policy page', fetchedAt: '2026-09-04T09:14:00Z' },
  mediaType: 'text/plain',
  hash: sha256(text),
  text,
};
const input = {
  document,
  documentEvidence: { evidenceId: 'document:abc', hash: sha256(text) },
  elements: DISCLOSURE_ELEMENTS,
  jurisdiction: 'DK' as const,
  locale: 'da' as const,
};

describe('the disclosure table', () => {
  it('names twelve elements, each resting on a provision that resolves in DK and in DE', () => {
    expect(DISCLOSURE_ELEMENTS).toHaveLength(12);
    for (const e of DISCLOSURE_ELEMENTS) {
      for (const jurisdiction of ['DK', 'DE'] as const) {
        const r = resolveInChunks(
          chunks,
          {
            kind: 'provision',
            instrument: e.citation.instrument,
            article: '13',
            ref: e.citation.ref,
            ...parse(e.citation.ref),
          },
          jurisdiction,
        );
        expect(r.ok, `${e.id} ${e.citation.ref} in ${jurisdiction}: ${!r.ok ? r.detail : ''}`).toBe(
          true,
        );
      }
      expect(e.findingTypeId === null || /^[A-Z]{2,4}-\d{2}$/.test(e.findingTypeId)).toBe(true);
    }
  });
});

function parse(ref: string): { paragraph?: string; point?: string } {
  const m = /^Art\. (\d+)\((\d+)\)(?:\(([a-z]+)\))?$/.exec(ref)!;
  return { paragraph: m[2]!, ...(m[3] ? { point: m[3] } : {}) };
}

describe('the prompt', () => {
  it('asks by element id, says undetermined beats a guess, and leaves the document to the client', () => {
    const { system, user } = policyClausesPrompt(input);
    expect(system).toBe(POLICY_CLAUSES_SYSTEM_PROMPT);
    expect(system).toMatch(/undetermined, not present/);
    for (const e of DISCLOSURE_ELEMENTS) expect(user).toContain(`- ${e.id}: ${e.asks}`);
    expect(user).not.toContain(text);
    expect(user).toMatch(/fenced as untrusted content/);
  });
});

describe('the analysis', () => {
  it('ties each answer to the table, drafts findings for absences the catalogue covers, and treats silence as undetermined', async () => {
    const client = {
      call: async () => ({
        clauses: [
          { element: 'retention', status: 'present' as const, quote: 'i fem år' },
          { element: 'complaint', status: 'absent' as const },
          { element: 'controller', status: 'absent' as const },
          { element: 'rights', status: 'undetermined' as const, note: 'mentions rights vaguely' },
        ],
      }),
    };
    const a = await analysePolicyClauses(client as never, input);
    expect(a.documentHash).toBe(sha256(text));
    const by = Object.fromEntries(a.clauses.map((c) => [c.element, c]));
    expect(by['retention']).toMatchObject({
      status: 'present',
      quote: 'i fem år',
      findingTypeId: 'POL-04',
    });
    expect(citationKey(by['retention']!.citation)).toBe('GDPR:13:2:a');
    expect(by['complaint']).toMatchObject({ status: 'absent', findingTypeId: 'POL-09' });
    expect(by['controller']).toMatchObject({ status: 'absent', findingTypeId: null });
    expect(by['rights']).toMatchObject({ status: 'undetermined', note: 'mentions rights vaguely' });
    expect(by['dpo']).toMatchObject({ status: 'undetermined' });
    expect(a.drafts).toEqual([
      { typeId: 'POL-09', element: 'complaint', evidence: [input.documentEvidence] },
    ]);
    expect(a.undetermined).toEqual(
      DISCLOSURE_ELEMENTS.map((e) => e.id).filter(
        (id) => !['retention', 'complaint', 'controller'].includes(id),
      ),
    );
  });
});
