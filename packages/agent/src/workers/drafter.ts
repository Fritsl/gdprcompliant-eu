import type { ArtefactKind, EvidenceRef, Locale } from '@gc/contracts';
import type { Worker } from '../dispatcher.js';
import { claimOf, done, failed, type WorkerIdentity } from './shared.js';

// The drafter (A-05): writes a document from the case graph through the generator it
// is given (G-02). It touches no site and no register; it returns where the draft is
// and a drafting claim on the evidence the draft was asked to rest on. The generator
// refuses while the register has gaps, and so does the drafter, naming them.

export interface Drafted {
  readonly artefactId: string;
  readonly kind: ArtefactKind;
  readonly version: number;
}

export type Generated =
  | { readonly ok: true; readonly artefact: Drafted }
  | { readonly ok: false; readonly gaps: readonly { readonly text: string }[] };

export interface DrafterDeps extends WorkerIdentity {
  readonly generate: (
    kind: ArtefactKind,
    locale: Locale,
    inputs: { readonly evidence: readonly EvidenceRef[]; readonly questionIds: readonly string[] },
  ) => Promise<Generated>;
  readonly now?: () => Date;
}

export const DRAFTER = 'drafter';

export function createDrafter(deps: DrafterDeps): Worker<'draft'> {
  const now = deps.now ?? (() => new Date());
  return async (task) => {
    const at = now();
    let generated: Generated;
    try {
      generated = await deps.generate(
        task.payload.artefact,
        task.payload.locale,
        task.payload.inputs,
      );
    } catch (e) {
      return failed(task, `the draft could not be written: ${(e as Error).message}`, true);
    }
    if (!generated.ok) {
      return failed(
        task,
        `the register has gaps: ${generated.gaps.map((g) => g.text).join('; ')}`,
        false,
      );
    }
    const claims =
      task.payload.inputs.evidence.length === 0
        ? []
        : [
            claimOf({
              caseId: deps.caseId,
              kind: 'drafting',
              statement: `A ${task.payload.artefact} draft (version ${generated.artefact.version}) was written in ${task.payload.locale} from the evidence given.`,
              evidence: task.payload.inputs.evidence,
              worker: DRAFTER,
              taskId: task.id,
              at,
            }),
          ];
    return done(
      task,
      { artefactId: generated.artefact.artefactId, kind: generated.artefact.kind },
      { claims },
    );
  };
}
