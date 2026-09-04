import {
  EvidenceSchema,
  canonicalJson,
  sha256,
  type Citation,
  type CorpusChunk,
  type Evidence,
  type Jurisdiction,
} from '@gc/contracts';
import type { Worker } from '../dispatcher.js';
import { claimOf, done, failed, refTo, type WorkerIdentity } from './shared.js';

// The researcher (A-05): finds the passages of the corpus that speak to a question, in
// the case's jurisdiction, and hands them back with their citations. It reads the
// corpus through the retrieval it is given (A-08) and nothing else: no site, no
// register, no model. A passage is returned, never a conclusion drawn from it.

export interface RetrievedPassage {
  readonly chunk: CorpusChunk;
  readonly distance: number;
}

export interface ResearcherDeps extends WorkerIdentity {
  readonly retrieve: (
    question: string,
    jurisdiction: Jurisdiction,
    k: number,
  ) => Promise<readonly RetrievedPassage[]>;
  // Where the corpus text was read, for the evidence row's source.
  readonly corpusSource?: { readonly url: string; readonly host: string };
  readonly now?: () => Date;
}

export const RESEARCHER = 'researcher';

const displayRef = (c: CorpusChunk): string => {
  let ref = `Art. ${c.article}`;
  if (c.paragraph !== undefined) ref += `(${c.paragraph})`;
  if (c.point !== undefined) ref += `(${c.point})`;
  return ref;
};

export function citationOf(c: CorpusChunk): Citation {
  return {
    kind: 'provision',
    instrument: c.instrument,
    article: c.article,
    ...(c.paragraph !== undefined ? { paragraph: c.paragraph } : {}),
    ...(c.point !== undefined ? { point: c.point } : {}),
    ref: displayRef(c),
  } as Citation;
}

export function createResearcher(deps: ResearcherDeps): Worker<'research'> {
  const now = deps.now ?? (() => new Date());
  const source = deps.corpusSource ?? {
    url: 'https://eur-lex.europa.eu/',
    host: 'eur-lex.europa.eu',
  };
  return async (task) => {
    const at = now();
    let found: readonly RetrievedPassage[];
    try {
      found = await deps.retrieve(
        task.payload.question,
        task.payload.jurisdiction,
        task.payload.maxPassages,
      );
    } catch (e) {
      return failed(task, `the corpus could not be searched: ${(e as Error).message}`, true);
    }
    const evidence: Evidence[] = found.map(({ chunk }) => {
      const body = canonicalJson({
        id: chunk.id,
        corpusVersion: chunk.corpusVersion,
        heading: chunk.heading ?? null,
        text: chunk.text,
      });
      const hash = sha256(body);
      return EvidenceSchema.parse({
        id: `text:${hash.slice(0, 16)}`,
        tenantId: deps.tenantId,
        caseId: deps.caseId,
        scanId: task.id,
        kind: 'text',
        capturedAt: at.toISOString(),
        source,
        body,
        hash,
        caption: `${chunk.instrument} ${displayRef(chunk)} (${chunk.corpusVersion})`,
      });
    });
    const passages = found.map(({ chunk }, i) => ({
      citation: citationOf(chunk),
      evidence: refTo(evidence[i]!),
    }));
    const claims = found.map(({ chunk }, i) =>
      claimOf({
        caseId: deps.caseId,
        kind: 'observation',
        statement: `${chunk.instrument} ${displayRef(chunk)} was retrieved for the question "${task.payload.question}".`,
        evidence: [refTo(evidence[i]!)],
        citations: [citationOf(chunk)],
        jurisdiction: task.payload.jurisdiction,
        corpusVersion: chunk.corpusVersion,
        worker: RESEARCHER,
        taskId: task.id,
        at,
      }),
    );
    return done(task, { passages }, { claims, evidence });
  };
}
