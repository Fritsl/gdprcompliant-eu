import type { Evidence, EvidenceRef, UntrustedContent } from '@gc/contracts';
import type { Worker } from '../dispatcher.js';
import type { ModelClient } from '../model-client.js';
import { claimOf, done, failed, type WorkerIdentity } from './shared.js';

// The contract reader (A-05): answers questions about a document the case already
// holds. It has no network: the document is stored evidence, read by id from the store
// it is given, and the only call it makes is to the model, with the document fenced
// as untrusted (A-10). Every answer is a claim on the document.

export interface ContractReaderDeps extends WorkerIdentity {
  readonly model: ModelClient;
  // The stored evidence row, in this tenant; undefined when there is none.
  readonly evidenceById: (id: string) => Promise<Evidence | undefined>;
  readonly locale?: 'en' | 'da' | 'de';
  readonly now?: () => Date;
}

export const CONTRACT_READER = 'contract_reader';

export const READER_SYSTEM_PROMPT = [
  'You read one contract or policy the company holds and answer questions about it.',
  'Answer from the document only. Quote the words that answer the question where you can.',
  'If the document does not answer the question, say exactly: The document does not say.',
  'Never say whether anything is lawful, compliant or approved; say what the document says.',
].join(' ');

export function createContractReader(deps: ContractReaderDeps): Worker<'read_contract'> {
  const now = deps.now ?? (() => new Date());
  return async (task) => {
    const at = now();
    const doc = await deps.evidenceById(task.payload.documentEvidenceId);
    if (!doc) {
      return failed(task, `no stored document ${task.payload.documentEvidenceId}`, false);
    }
    const untrusted: UntrustedContent = {
      trust: 'untrusted',
      source: {
        url: doc.source.url,
        description: doc.caption ?? 'a stored document',
        fetchedAt: doc.capturedAt,
      },
      mediaType: 'text/plain',
      hash: doc.hash,
      text: doc.body,
    };
    const ref: EvidenceRef = { evidenceId: doc.id, hash: doc.hash };
    const answers: { question: string; answer: string; evidence: EvidenceRef }[] = [];
    for (const question of task.payload.questions) {
      const out = await deps.model.call({
        name: 'answer_question',
        input: { question, locale: deps.locale ?? 'en', untrusted: [untrusted] },
        system: READER_SYSTEM_PROMPT,
        user: question,
      });
      answers.push({ question, answer: out.answer, evidence: ref });
    }
    const claims = answers.map((a) =>
      claimOf({
        caseId: deps.caseId,
        kind: 'observation',
        statement: `The document answers "${a.question}": ${a.answer}`,
        evidence: [ref],
        worker: CONTRACT_READER,
        taskId: task.id,
        at,
      }),
    );
    return done(task, { answers }, { claims });
  };
}
