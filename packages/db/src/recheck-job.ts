import { z } from 'zod';
import { ActorSchema, CaseIdSchema, IdSchema, TenantIdSchema } from '@gc/contracts';
import { defineJob, type JobQueue } from '@gc/jobs';

// "Check it again" as a job (U-04, C-05): the case page enqueues, the worker re-runs the
// finding's check family against the live site and records the outcome, and the page
// reads it back. The outcome is what the scanner saw, including that it saw nothing.

export const RECHECK_OUTCOMES = [
  'closed',
  'open',
  'regressed',
  'unverifiable',
  'unreachable',
] as const;
export type RecheckOutcome = (typeof RECHECK_OUTCOMES)[number];

export const RecheckProgressSchema = z.object({
  outcome: z.enum(RECHECK_OUTCOMES).optional(),
  // A short reason for unverifiable and unreachable; never page text.
  detail: z.string().max(300).optional(),
  at: z.iso.datetime().optional(),
  checksRun: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().nonnegative().optional(),
});
export type RecheckProgress = z.infer<typeof RecheckProgressSchema>;

export const RECHECK_JOB = defineJob({
  name: 'recheck-finding',
  payload: z.object({
    tenantId: TenantIdSchema,
    caseId: CaseIdSchema,
    findingId: IdSchema,
    requestedBy: ActorSchema,
  }),
  progress: RecheckProgressSchema,
  retryLimit: 0,
});
export type RecheckPayload = z.infer<typeof RECHECK_JOB.payload>;

export async function recheckStatus(queue: JobQueue, id: string) {
  return queue.status(RECHECK_JOB, id);
}
