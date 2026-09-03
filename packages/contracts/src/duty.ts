import { z } from 'zod';
import { CitationSchema } from './citation.js';
import { EvidenceRefSchema } from './evidence.js';
import {
  CaseIdSchema,
  FindingTypeIdSchema,
  IdSchema,
  JurisdictionSchema,
  LocalisedTextSchema,
  NonEmptyStringSchema,
} from './primitives.js';

// A duty is what the obligations engine (A-02) concludes applies to a company: the output
// of a versioned, human-authored rule evaluated against graph state. Every rule carries a
// citation that resolves, so every duty does too.

export const DUTY_STATUSES = ['applies', 'not_applicable', 'undetermined'] as const;
export const DutyStatusSchema = z.enum(DUTY_STATUSES);
export type DutyStatus = z.infer<typeof DutyStatusSchema>;

export const DutySchema = z
  .object({
    id: IdSchema,
    caseId: CaseIdSchema,
    ruleId: NonEmptyStringSchema.describe('Rule id in the rule set'),
    ruleVersion: NonEmptyStringSchema.describe('Rule set version the duty was evaluated under'),
    jurisdiction: JurisdictionSchema,
    title: LocalisedTextSchema,
    status: DutyStatusSchema,
    citations: z.array(CitationSchema).min(1, 'a duty cites the provision it comes from'),
    // Why the rule fired: the observations and answers it read.
    because: z.object({
      evidence: z.array(EvidenceRefSchema).default([]),
      questionIds: z.array(IdSchema).default([]),
    }),
    // Finding types that, when raised, show this duty is not met.
    findingTypeIds: z.array(FindingTypeIdSchema).default([]),
  })
  .describe('An obligation the rule engine derived for a company');
export type Duty = z.infer<typeof DutySchema>;
