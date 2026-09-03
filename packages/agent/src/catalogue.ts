import { z } from 'zod';
import {
  ArtefactKindSchema,
  CitationSchema,
  EvidenceRefSchema,
  IdSchema,
  NonEmptyStringSchema,
  PlannerTaskSchema,
  ScanPassSchema,
  TASK_PAYLOADS,
  TASK_TYPES,
  TaskProposalSchema,
  TaskTypeSchema,
  VerifierVerdictSchema,
  type PlannerTask,
  type TaskCost,
  type TaskProposal,
  type TaskType,
} from '@gc/contracts';

// The task catalogue (A-04): the finite vocabulary the planner may emit. One entry per
// type, closed: a type not here is rejected at the boundary, loudly. Each entry says
// what a task takes, what it must return, what it costs, and how often it may be tried.
// Costs are functions of the payload, so a wide crawl costs more than a shallow one and
// the planner is held to a budget it can reason about.

export interface TaskSpec<T extends TaskType = TaskType> {
  readonly type: T;
  readonly payload: (typeof TASK_PAYLOADS)[T];
  // What a worker for this type must hand back, beyond claims and evidence.
  readonly output: z.ZodType;
  readonly cost: (payload: z.infer<(typeof TASK_PAYLOADS)[T]>) => TaskCost;
  readonly maxAttempts: number;
  // Whether the worker may reach the network at all (A-05: readers have none).
  readonly network: boolean;
}

const spec = <T extends TaskType>(s: TaskSpec<T>): TaskSpec<T> => s;

export const TASK_CATALOGUE = {
  crawl: spec({
    type: 'crawl',
    payload: TASK_PAYLOADS.crawl,
    output: z.strictObject({
      passes: z
        .array(z.strictObject({ pass: ScanPassSchema, evidenceIds: z.array(IdSchema) }))
        .min(1),
    }),
    cost: (p) => ({
      credits: 10 * p.passes.length * (p.depth + 1),
      estimatedSeconds: 30 * p.passes.length * (p.depth + 1),
    }),
    maxAttempts: 2,
    network: true,
  }),
  read_contract: spec({
    type: 'read_contract',
    payload: TASK_PAYLOADS.read_contract,
    output: z.strictObject({
      answers: z
        .array(
          z.strictObject({
            question: NonEmptyStringSchema,
            answer: NonEmptyStringSchema,
            evidence: EvidenceRefSchema,
          }),
        )
        .min(1),
    }),
    cost: (p) => ({
      credits: 5 + p.questions.length,
      modelTokens: 4_000 + 800 * p.questions.length,
    }),
    maxAttempts: 2,
    network: false,
  }),
  registry_lookup: spec({
    type: 'registry_lookup',
    payload: TASK_PAYLOADS.registry_lookup,
    output: z.strictObject({
      matches: z.array(
        z.strictObject({
          registryId: NonEmptyStringSchema,
          name: NonEmptyStringSchema,
          evidence: EvidenceRefSchema,
        }),
      ),
    }),
    cost: () => ({ credits: 2, estimatedSeconds: 5 }),
    maxAttempts: 3,
    network: true,
  }),
  research: spec({
    type: 'research',
    payload: TASK_PAYLOADS.research,
    output: z.strictObject({
      passages: z.array(z.strictObject({ citation: CitationSchema, evidence: EvidenceRefSchema })),
    }),
    cost: (p) => ({ credits: 3 + p.maxPassages, modelTokens: 1_500 + 400 * p.maxPassages }),
    maxAttempts: 2,
    network: false,
  }),
  draft: spec({
    type: 'draft',
    payload: TASK_PAYLOADS.draft,
    output: z.strictObject({ artefactId: IdSchema, kind: ArtefactKindSchema }),
    cost: () => ({ credits: 15, modelTokens: 12_000 }),
    maxAttempts: 2,
    network: false,
  }),
  verify_claims: spec({
    type: 'verify_claims',
    payload: TASK_PAYLOADS.verify_claims,
    output: z.strictObject({ verdicts: z.array(VerifierVerdictSchema).min(1) }),
    cost: (p) => ({ credits: p.claimIds.length, modelTokens: 600 * p.claimIds.length }),
    maxAttempts: 1,
    network: false,
  }),
} as const satisfies { [T in TaskType]: TaskSpec<T> };

export const TASK_CATALOGUE_TYPES = Object.keys(TASK_CATALOGUE) as TaskType[];

export class UnknownTaskType extends Error {
  constructor(readonly offered: unknown) {
    super(
      `task type ${JSON.stringify(offered)} is not in the catalogue (${TASK_TYPES.join(', ')})`,
    );
    this.name = 'UnknownTaskType';
  }
}

export class InvalidTaskProposal extends Error {
  constructor(
    readonly type: TaskType,
    readonly issues: readonly string[],
  ) {
    super(`${type} proposal rejected: ${issues.join('; ')}`);
    this.name = 'InvalidTaskProposal';
  }
}

export function specFor<T extends TaskType>(type: T): TaskSpec<T> {
  const parsed = TaskTypeSchema.safeParse(type);
  if (!parsed.success) throw new UnknownTaskType(type);
  return TASK_CATALOGUE[type] as TaskSpec<T>;
}

export function costOf(proposal: TaskProposal): TaskCost {
  const s = specFor(proposal.type) as TaskSpec;
  return s.cost(proposal.payload as never);
}

export interface AcceptContext {
  readonly caseId: string;
  readonly id: string;
  readonly now: Date;
  readonly dependsOn?: readonly string[];
}

// The boundary. Whatever a model emitted comes through here; ids, cost and status are
// assigned on this side, never taken from the model.
export function acceptProposal(raw: unknown, ctx: AcceptContext): PlannerTask {
  const type = (raw as { type?: unknown } | null)?.type;
  if (!TaskTypeSchema.safeParse(type).success) throw new UnknownTaskType(type);
  const parsed = TaskProposalSchema.safeParse(raw);
  if (!parsed.success) {
    throw new InvalidTaskProposal(
      type as TaskType,
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`),
    );
  }
  const proposal = parsed.data;
  return PlannerTaskSchema.parse({
    id: ctx.id,
    caseId: ctx.caseId,
    type: proposal.type,
    payload: proposal.payload,
    cost: costOf(proposal),
    dependsOn: [...(ctx.dependsOn ?? [])],
    status: 'pending',
    attempts: 0,
    createdAt: ctx.now.toISOString(),
  });
}

// Sample payloads, one per type: the catalogue's own proof that every entry is
// constructible, and the fixture the dispatcher test builds from.
export const SAMPLE_PAYLOADS: { [T in TaskType]: z.input<(typeof TASK_PAYLOADS)[T]> } = {
  crawl: { url: 'https://eksempelbutik.dk/', depth: 1, passes: ['A', 'B'] },
  read_contract: { documentEvidenceId: 'document:abc', questions: ['Who is the processor?'] },
  registry_lookup: { registry: 'cvr', query: { domain: 'eksempelbutik.dk' } },
  research: { question: 'Is a reject button required?', jurisdiction: 'DK', maxPassages: 5 },
  draft: { artefact: 'privacy_policy', locale: 'da', inputs: { evidence: [], questionIds: [] } },
  verify_claims: { claimIds: ['claim-1', 'claim-2'] },
};
