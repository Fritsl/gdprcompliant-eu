import { z } from 'zod';
import { CitationSchema } from './citation.js';
import { EvidenceRefSchema } from './evidence.js';
import {
  CaseIdSchema,
  IdSchema,
  IsoDateTimeSchema,
  JurisdictionSchema,
  NonEmptyStringSchema,
} from './primitives.js';

// Workers return claims, never conclusions (A-05). A claim is a statement plus the
// evidence it rests on and, if it is a legal claim, the citation it relies on. Nothing
// enters the graph until the verifier (A-07) has accepted the claim.

export const CLAIM_KINDS = ['observation', 'legal', 'drafting'] as const;
export const ClaimKindSchema = z.enum(CLAIM_KINDS);
export type ClaimKind = z.infer<typeof ClaimKindSchema>;

export const ClaimProducerSchema = z
  .object({
    worker: NonEmptyStringSchema.describe('Worker name, e.g. contract_reader'),
    taskId: IdSchema.optional(),
    model: z.string().optional(),
    promptVersion: z.string().optional(),
  })
  .describe('Who produced the claim');
export type ClaimProducer = z.infer<typeof ClaimProducerSchema>;

export const ClaimSchema = z
  .object({
    id: IdSchema,
    caseId: CaseIdSchema,
    kind: ClaimKindSchema,
    statement: NonEmptyStringSchema,
    evidence: z.array(EvidenceRefSchema).min(1, 'a claim without an evidence pointer cannot exist'),
    citations: z.array(CitationSchema).default([]),
    jurisdiction: JurisdictionSchema.optional(),
    producedBy: ClaimProducerSchema,
    at: IsoDateTimeSchema,
  })
  .superRefine((c, ctx) => {
    if (c.kind === 'legal' && c.citations.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['citations'],
        message: 'a legal claim must cite at least one provision',
      });
    }
    if (c.kind === 'legal' && c.jurisdiction === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['jurisdiction'],
        message: 'a legal claim must state the jurisdiction its citation resolves in',
      });
    }
  })
  .describe('A statement with evidence and, for legal claims, a citation');
export type Claim = z.infer<typeof ClaimSchema>;

export const VERIFIER_CHECKS = [
  'evidence_exists',
  'quote_matches_source',
  'citation_resolves',
  'model_review',
] as const;
export const VerifierCheckNameSchema = z.enum(VERIFIER_CHECKS);
export type VerifierCheckName = z.infer<typeof VerifierCheckNameSchema>;

export const VerifierCheckSchema = z.object({
  name: VerifierCheckNameSchema,
  passed: z.boolean(),
  detail: z.string().optional(),
});
export type VerifierCheck = z.infer<typeof VerifierCheckSchema>;

export const VerifierVerdictSchema = z
  .object({
    claimId: IdSchema,
    verdict: z.enum(['accepted', 'rejected']),
    checks: z.array(VerifierCheckSchema).min(1),
    reason: z.string().optional(),
    at: IsoDateTimeSchema,
  })
  .superRefine((v, ctx) => {
    if (v.verdict === 'rejected' && (v.reason === undefined || v.reason.trim() === '')) {
      ctx.addIssue({
        code: 'custom',
        path: ['reason'],
        message: 'a rejection is recorded with a reason',
      });
    }
    if (v.verdict === 'accepted' && v.checks.some((c) => !c.passed)) {
      ctx.addIssue({
        code: 'custom',
        path: ['checks'],
        message: 'a claim is not accepted while a check has failed',
      });
    }
  })
  .describe('The verifier gate’s decision on one claim');
export type VerifierVerdict = z.infer<typeof VerifierVerdictSchema>;
