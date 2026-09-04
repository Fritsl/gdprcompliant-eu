import { z } from 'zod';
import { ClaimSchema } from './claim.js';
import { EvidenceRefSchema, EvidenceSchema } from './evidence.js';
import {
  CaseIdSchema,
  IdSchema,
  IsoDateTimeSchema,
  JurisdictionSchema,
  LocaleSchema,
  NonEmptyStringSchema,
  ScanPassSchema,
  UrlSchema,
} from './primitives.js';
import { ArtefactKindSchema } from './remedy.js';

// The finite vocabulary the planner may emit (A-04). A task type not in this file does
// not exist: the union rejects it at the boundary. Every task carries a cost so the
// dispatcher can hold the planner to a budget.

export const TASK_TYPES = [
  'crawl',
  'read_contract',
  'registry_lookup',
  'research',
  'draft',
  'verify_claims',
] as const;
export const TaskTypeSchema = z.enum(TASK_TYPES).describe('The closed task catalogue');
export type TaskType = z.infer<typeof TaskTypeSchema>;

export const TaskCostSchema = z
  .object({
    credits: z.number().min(0).describe('Budget units'),
    estimatedSeconds: z.number().int().min(0).optional(),
    modelTokens: z.number().int().min(0).optional(),
  })
  .describe('What a task costs');
export type TaskCost = z.infer<typeof TaskCostSchema>;

export const TASK_PAYLOADS = {
  crawl: z.object({
    url: UrlSchema,
    depth: z.number().int().min(0).max(3),
    passes: z.array(ScanPassSchema).min(1),
  }),
  read_contract: z.object({
    // The document is stored evidence; the reader has no network (A-05).
    documentEvidenceId: IdSchema,
    questions: z.array(NonEmptyStringSchema).min(1),
  }),
  registry_lookup: z.object({
    registry: NonEmptyStringSchema,
    query: z
      .object({
        name: z.string().optional(),
        registryId: z.string().optional(),
        domain: z.string().optional(),
      })
      .refine((q) => q.name !== undefined || q.registryId !== undefined || q.domain !== undefined, {
        message: 'a lookup needs a name, an id or a domain',
      }),
  }),
  research: z.object({
    question: NonEmptyStringSchema,
    jurisdiction: JurisdictionSchema,
    maxPassages: z.number().int().min(1).max(20).default(5),
  }),
  draft: z.object({
    artefact: ArtefactKindSchema,
    locale: LocaleSchema,
    inputs: z.object({
      evidence: z.array(EvidenceRefSchema).default([]),
      questionIds: z.array(IdSchema).default([]),
    }),
  }),
  verify_claims: z.object({
    claimIds: z.array(IdSchema).min(1),
  }),
} as const satisfies Record<TaskType, z.ZodType>;

export const TASK_STATUSES = ['pending', 'running', 'done', 'failed', 'skipped'] as const;
export const TaskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

function task<T extends TaskType>(type: T) {
  return z.object({
    id: IdSchema,
    caseId: CaseIdSchema,
    type: z.literal(type),
    payload: TASK_PAYLOADS[type],
    cost: TaskCostSchema,
    dependsOn: z.array(IdSchema).default([]),
    status: TaskStatusSchema.default('pending'),
    attempts: z.number().int().min(0).default(0),
    createdAt: IsoDateTimeSchema,
    // The planner's one line on why, for the case page (A-06).
    rationale: NonEmptyStringSchema.optional(),
  });
}

export const PlannerTaskSchema = z
  .discriminatedUnion('type', [
    task('crawl'),
    task('read_contract'),
    task('registry_lookup'),
    task('research'),
    task('draft'),
    task('verify_claims'),
  ])
  .describe('One unit of planned work, with its cost');
export type PlannerTask = z.infer<typeof PlannerTaskSchema>;

// What the planner model proposes: type and payload only. Ids, cost and status are
// assigned by the dispatcher, never by the model.
function proposal<T extends TaskType>(type: T) {
  return z.strictObject({
    type: z.literal(type),
    payload: TASK_PAYLOADS[type],
    rationale: NonEmptyStringSchema,
  });
}
export const TaskProposalSchema = z.discriminatedUnion('type', [
  proposal('crawl'),
  proposal('read_contract'),
  proposal('registry_lookup'),
  proposal('research'),
  proposal('draft'),
  proposal('verify_claims'),
]);
export type TaskProposal = z.infer<typeof TaskProposalSchema>;

export const PlanSchema = z
  .object({
    caseId: CaseIdSchema,
    budget: TaskCostSchema,
    tasks: z.array(PlannerTaskSchema),
  })
  .superRefine((p, ctx) => {
    const ids = new Set(p.tasks.map((t) => t.id));
    p.tasks.forEach((t, i) => {
      for (const dep of t.dependsOn) {
        if (!ids.has(dep)) {
          ctx.addIssue({
            code: 'custom',
            path: ['tasks', i, 'dependsOn'],
            message: `depends on unknown task ${dep}`,
          });
        }
      }
    });
    const total = p.tasks.reduce((sum, t) => sum + t.cost.credits, 0);
    if (total > p.budget.credits) {
      ctx.addIssue({
        code: 'custom',
        path: ['tasks'],
        message: `plan costs ${total} credits against a budget of ${p.budget.credits}`,
      });
    }
  })
  .describe('A set of tasks that fits its budget');
export type Plan = z.infer<typeof PlanSchema>;

// Workers return claims, never conclusions (A-05).
export const TaskResultSchema = z
  .object({
    taskId: IdSchema,
    type: TaskTypeSchema,
    claims: z.array(ClaimSchema).default([]),
    evidence: z.array(EvidenceSchema).default([]),
    cost: TaskCostSchema.describe('Actual cost'),
    failure: z.object({ reason: NonEmptyStringSchema, retryable: z.boolean() }).optional(),
  })
  .describe('What a worker returned');
export type TaskResult = z.infer<typeof TaskResultSchema>;
