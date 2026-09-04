import type { Claim, VerifierVerdict } from '@gc/contracts';
import type { Worker } from '../dispatcher.js';
import { verifyClaim, type VerifierDeps } from '../verifier.js';
import { done, type WorkerIdentity } from './shared.js';

// The claim verifier as a worker (A-05, A-07): the gate, run as a task. It loads the
// claims it is asked about and returns a verdict for each; a claim it cannot find is
// rejected, with the reason, so nothing enters the graph on a name alone.

export interface ClaimVerifierDeps extends WorkerIdentity {
  readonly claimsById: (ids: readonly string[]) => Promise<readonly Claim[]>;
  readonly verifier: VerifierDeps;
}

export const CLAIM_VERIFIER = 'claim_verifier';

export function createClaimVerifier(deps: ClaimVerifierDeps): Worker<'verify_claims'> {
  return async (task) => {
    const found = await deps.claimsById(task.payload.claimIds);
    const now = deps.verifier.now ?? (() => new Date());
    const verdicts: VerifierVerdict[] = [];
    for (const id of task.payload.claimIds) {
      const claim = found.find((c) => c.id === id);
      if (!claim) {
        verdicts.push({
          claimId: id,
          verdict: 'rejected',
          checks: [{ name: 'evidence_exists', passed: false, detail: 'no such claim' }],
          reason: `no claim ${id} was offered`,
          at: now().toISOString(),
        });
        continue;
      }
      verdicts.push(await verifyClaim(claim, deps.verifier));
    }
    return done(task, { verdicts });
  };
}
