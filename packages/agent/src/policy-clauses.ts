import {
  ClauseAnalysisSchema,
  parseProvisionRef,
  type ClauseAnalysis,
  type ClauseResult,
  type DisclosureElement,
  type EvidenceRef,
  type Jurisdiction,
  type Locale,
  type UntrustedContent,
} from '@gc/contracts';
import type { ModelClient } from './model-client.js';

// Clause analysis (S-10): the policy, clause by clause, against what Article 13 says it
// must tell the reader. The model reads the document — fenced, as data — and says for
// each element whether it is present, absent or undetermined, quoting the clause when
// present. The client's guard has already checked every quote against the document by
// substring; here the answer is tied back to the table: the provision each element
// rests on, the finding raised when it is absent, and "undetermined" for any element
// the model did not answer. Nothing here trusts the model with a fact.

export interface PolicyClausesInput {
  readonly document: UntrustedContent;
  // The stored evidence the document was read from; findings point at it.
  readonly documentEvidence: EvidenceRef;
  readonly elements: readonly DisclosureElement[];
  readonly jurisdiction: Jurisdiction;
  readonly locale: Locale;
}

export const POLICY_CLAUSES_SYSTEM_PROMPT = [
  'You read one privacy policy and check it, element by element, against a list of',
  'things such a policy must tell the reader. For each element answer "present" only if',
  'the document actually says it, and quote the sentence or clause verbatim from the',
  'document; answer "absent" if the document says nothing about it; answer',
  '"undetermined" if the document touches on it but does not clearly say it, or if',
  'you are not sure. Never guess: an unclear clause is undetermined, not present.',
  'Do not paraphrase in the quote. Answer as JSON.',
].join(' ');

export function policyClausesPrompt(input: PolicyClausesInput): { system: string; user: string } {
  const lines: string[] = [];
  lines.push(`The policy is for a company in ${input.jurisdiction}. Check these elements:`);
  for (const e of input.elements) lines.push(`- ${e.id}: ${e.asks}`);
  lines.push('');
  lines.push(
    'Answer with one entry per element id, in the order given. The document follows, fenced as untrusted content.',
  );
  return { system: POLICY_CLAUSES_SYSTEM_PROMPT, user: lines.join('\n') };
}

export async function analysePolicyClauses(
  client: Pick<ModelClient, 'call'>,
  input: PolicyClausesInput,
): Promise<ClauseAnalysis> {
  const output = await client.call({
    name: 'analyse_policy_clauses',
    input: {
      document: input.document,
      elements: input.elements.map((e) => e.id),
      jurisdiction: input.jurisdiction,
      locale: input.locale,
    },
    ...policyClausesPrompt(input),
  });
  const answered = new Map(output.clauses.map((c) => [c.element, c]));
  const clauses: ClauseResult[] = input.elements.map((e) => {
    const a = answered.get(e.id);
    const citation = parseProvisionRef(e.citation.instrument, e.citation.ref, {
      ...(e.citation.note !== undefined ? { note: e.citation.note } : {}),
    });
    if (!citation)
      throw new Error(
        `disclosure ${e.id} cites "${e.citation.instrument} ${e.citation.ref}", which does not parse`,
      );
    return {
      element: e.id,
      status: a?.status ?? 'undetermined',
      ...(a?.status === 'present' && a.quote !== undefined ? { quote: a.quote } : {}),
      ...(a?.note !== undefined ? { note: a.note } : {}),
      citation,
      findingTypeId: e.findingTypeId,
    };
  });
  return ClauseAnalysisSchema.parse({
    documentHash: input.document.hash,
    jurisdiction: input.jurisdiction,
    locale: input.locale,
    clauses,
    drafts: clauses
      .filter((c) => c.status === 'absent' && c.findingTypeId !== null)
      .map((c) => ({
        typeId: c.findingTypeId!,
        element: c.element,
        evidence: [input.documentEvidence],
      })),
    undetermined: clauses.filter((c) => c.status === 'undetermined').map((c) => c.element),
  });
}
