import {
  ClaimSchema,
  canonicalJson,
  sha256,
  type Claim,
  type ClaimKind,
  type Evidence,
  type EvidenceRef,
  type PlannerTask,
  type TaskCost,
  type TaskResult,
} from '@gc/contracts';
import type { TaskOutcome } from '../dispatcher.js';

// What every worker shares (A-05): a claim is a statement with the evidence it rests
// on, produced by a named worker for a named task; a result is claims, evidence and
// what the task cost. Nothing here reaches a network, a database or a model: a worker
// gets those, when it needs them, as the narrowest function that does the job.

export interface WorkerIdentity {
  readonly tenantId: string;
  readonly caseId: string;
}

export const refTo = (e: Evidence): EvidenceRef => ({ evidenceId: e.id, hash: e.hash });

export function claimOf(input: {
  readonly caseId: string;
  readonly kind: ClaimKind;
  readonly statement: string;
  readonly evidence: readonly EvidenceRef[];
  readonly citations?: Claim['citations'];
  readonly jurisdiction?: Claim['jurisdiction'];
  readonly corpusVersion?: string;
  readonly worker: string;
  readonly taskId: string;
  readonly model?: string;
  readonly at: Date;
}): Claim {
  const id = `claim:${sha256(
    canonicalJson({
      caseId: input.caseId,
      kind: input.kind,
      statement: input.statement,
      evidence: input.evidence,
      worker: input.worker,
      taskId: input.taskId,
    }),
  ).slice(0, 16)}`;
  return ClaimSchema.parse({
    id,
    caseId: input.caseId,
    kind: input.kind,
    statement: input.statement,
    evidence: [...input.evidence],
    citations: [...(input.citations ?? [])],
    ...(input.jurisdiction ? { jurisdiction: input.jurisdiction } : {}),
    ...(input.corpusVersion ? { corpusVersion: input.corpusVersion } : {}),
    producedBy: {
      worker: input.worker,
      taskId: input.taskId,
      ...(input.model ? { model: input.model } : {}),
    },
    at: input.at.toISOString(),
  });
}

export function done(
  task: PlannerTask,
  output: unknown,
  parts: { claims?: readonly Claim[]; evidence?: readonly Evidence[]; cost?: TaskCost } = {},
): TaskOutcome {
  const result: TaskResult = {
    taskId: task.id,
    type: task.type,
    claims: [...(parts.claims ?? [])],
    evidence: [...(parts.evidence ?? [])],
    cost: parts.cost ?? task.cost,
  };
  return { result, output };
}

export function failed(
  task: PlannerTask,
  reason: string,
  retryable: boolean,
  cost?: TaskCost,
): TaskOutcome {
  const result: TaskResult = {
    taskId: task.id,
    type: task.type,
    claims: [],
    evidence: [],
    cost: cost ?? task.cost,
    failure: { reason, retryable },
  };
  return { result, output: undefined };
}
