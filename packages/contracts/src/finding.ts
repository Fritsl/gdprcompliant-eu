import { z } from 'zod';
import { CitationSchema } from './citation.js';
import { EvidenceRefSchema } from './evidence.js';
import {
  CaseIdSchema,
  FindingTypeIdSchema,
  HostnameSchema,
  IdSchema,
  IsoDateTimeSchema,
  JurisdictionSchema,
  LocaleSchema,
  LocalisedTextSchema,
  NonEmptyStringSchema,
  TenantIdSchema,
  UrlSchema,
} from './primitives.js';
import { RemedyRefSchema } from './remedy.js';

// A finding has one stable identity and many jurisdiction-scoped bindings (I-02). The
// identity says what was observed; the binding says which instrument, article and
// authority that means in the case's jurisdiction. Detector code sees only the identity.

export const SEVERITIES = ['blocking', 'serious', 'advisory'] as const;
export const SeveritySchema = z.enum(SEVERITIES).describe('Severity, from a documented rule table');
export type Severity = z.infer<typeof SeveritySchema>;

export const FINDING_AREAS = [
  'Consent',
  'Contracts',
  'Security',
  'Transfers',
  'Observation',
  'Notice',
  'Recipients',
  'Collection',
] as const;
export const FindingAreaSchema = z
  .enum(FINDING_AREAS)
  .describe('The area of the case a finding belongs to');
export type FindingArea = z.infer<typeof FindingAreaSchema>;

export const FINDING_STATUSES = ['open', 'working', 'closed', 'regressed'] as const;
export const FindingStatusSchema = z.enum(FINDING_STATUSES);
export type FindingStatus = z.infer<typeof FindingStatusSchema>;

// The catalogue entry for a finding type: the stable identity. No article, no authority.
export const FindingTypeSchema = z
  .object({
    id: FindingTypeIdSchema,
    area: FindingAreaSchema,
    defaultSeverity: SeveritySchema,
    title: LocalisedTextSchema,
    summary: LocalisedTextSchema,
    // The detector module that raises it, e.g. 'consent/reject-not-honoured'.
    detector: NonEmptyStringSchema,
    version: z.number().int().min(1),
  })
  .describe('A finding type: stable identity without legal binding');
export type FindingType = z.infer<typeof FindingTypeSchema>;

// One row of the binding table: what a finding type means in one jurisdiction. Data,
// reviewable by a lawyer without reading code.
export const JurisdictionBindingSchema = z
  .object({
    findingTypeId: FindingTypeIdSchema,
    jurisdiction: JurisdictionSchema,
    citations: z.array(CitationSchema).min(1, 'a binding names at least one provision'),
    authority: z.object({
      name: NonEmptyStringSchema.describe('Supervisory authority, e.g. Datatilsynet'),
      url: UrlSchema.optional(),
    }),
    // The guide is translatable content (I-01), referenced by id.
    guideId: z
      .string()
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'guide slug')
      .describe('Guide content id'),
    version: z.number().int().min(1),
  })
  .describe('What a finding type means in one jurisdiction');
export type JurisdictionBinding = z.infer<typeof JurisdictionBindingSchema>;

// The binding table as content (I-02): one file per jurisdiction, written the way a
// lawyer reads it. Citations are the instrument and the display reference ("GDPR",
// "Art. 7(3)"), or "Case law" and the decision; code turns them into typed citations
// and the corpus resolves them. `reviewed` names who last reviewed the table and when.
export const BindingRowSchema = z.object({
  findingTypeId: FindingTypeIdSchema,
  citations: z
    .array(
      z.object({
        instrument: NonEmptyStringSchema,
        ref: NonEmptyStringSchema,
        note: z.string().optional(),
        jurisdiction: JurisdictionSchema.optional(),
      }),
    )
    .min(1, 'a binding names at least one provision'),
  guideId: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'guide slug'),
  version: z.number().int().min(1).optional(),
});
export type BindingRow = z.infer<typeof BindingRowSchema>;

export const BindingTableSchema = z
  .object({
    jurisdiction: JurisdictionSchema,
    version: z.number().int().min(1),
    reviewed: z
      .object({ by: NonEmptyStringSchema, at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })
      .nullable(),
    authority: z.object({ name: NonEmptyStringSchema, url: UrlSchema.optional() }),
    bindings: z.array(BindingRowSchema).min(1),
  })
  .superRefine((t, ctx) => {
    const seen = new Set<string>();
    t.bindings.forEach((b, i) => {
      if (seen.has(b.findingTypeId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['bindings', i],
          message: `${b.findingTypeId} is bound twice`,
        });
      }
      seen.add(b.findingTypeId);
    });
  })
  .describe('What every finding type means in one jurisdiction, as content');
export type BindingTable = z.infer<typeof BindingTableSchema>;

// What, specifically, the finding is about. Part of the fingerprint so the same problem
// is recognised across re-scans (S-14) and two problems of one type stay distinct.
export const FindingSubjectSchema = z
  .object({
    host: HostnameSchema.optional(),
    path: z.string().optional(),
    vendorId: IdSchema.optional(),
  })
  .describe('The host, path or vendor the finding concerns');
export type FindingSubject = z.infer<typeof FindingSubjectSchema>;

export function findingFingerprint(typeId: string, subject: FindingSubject = {}): string {
  return [typeId, subject.host ?? '', subject.path ?? '', subject.vendorId ?? ''].join('|');
}

// The model's explanation of a finding: prose that must point at evidence.
export const FindingExplanationSchema = z
  .object({
    locale: LocaleSchema,
    why: NonEmptyStringSchema,
    evidence: z.array(EvidenceRefSchema).min(1),
  })
  .describe('Model-drafted explanation, grounded in evidence');
export type FindingExplanation = z.infer<typeof FindingExplanationSchema>;

export const FindingSchema = z
  .object({
    id: IdSchema,
    tenantId: TenantIdSchema,
    caseId: CaseIdSchema,
    scanId: IdSchema.optional(),
    typeId: FindingTypeIdSchema,
    fingerprint: NonEmptyStringSchema,
    jurisdiction: JurisdictionSchema,
    binding: JurisdictionBindingSchema,
    severity: SeveritySchema,
    status: FindingStatusSchema,
    area: FindingAreaSchema,
    subject: FindingSubjectSchema.optional(),
    evidence: z.array(EvidenceRefSchema).min(1, 'a finding without evidence cannot exist'),
    // Required, not optional: the type cannot be constructed without a remedy (R-02).
    remedy: RemedyRefSchema,
    explanation: FindingExplanationSchema.optional(),
    firstSeenAt: IsoDateTimeSchema,
    lastSeenAt: IsoDateTimeSchema,
    closedAt: IsoDateTimeSchema.optional(),
  })
  .superRefine((f, ctx) => {
    if (f.binding.jurisdiction !== f.jurisdiction) {
      ctx.addIssue({
        code: 'custom',
        path: ['binding', 'jurisdiction'],
        message: `binding is for ${f.binding.jurisdiction} but the finding is in ${f.jurisdiction}`,
      });
    }
    if (f.binding.findingTypeId !== f.typeId) {
      ctx.addIssue({
        code: 'custom',
        path: ['binding', 'findingTypeId'],
        message: `binding is for ${f.binding.findingTypeId} but the finding is ${f.typeId}`,
      });
    }
    if (f.closedAt !== undefined && f.status !== 'closed') {
      ctx.addIssue({
        code: 'custom',
        path: ['closedAt'],
        message: 'only a closed finding has closedAt',
      });
    }
    if (f.status === 'closed' && f.closedAt === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['closedAt'],
        message: 'a closed finding records when it closed',
      });
    }
  })
  .describe('A persisted finding: identity, binding, evidence, severity, remedy');
export type Finding = z.infer<typeof FindingSchema>;

// A check the scanner could not decide is an outcome in its own right, never a pass and
// never a failure. It says why, and what would resolve it.
export const UndeterminedCheckSchema = z
  .object({
    id: IdSchema,
    caseId: CaseIdSchema,
    typeId: FindingTypeIdSchema,
    reason: NonEmptyStringSchema,
    resolvedBy: z.enum(['question', 'review', 'rescan']),
    questionId: IdSchema.optional(),
    evidence: z.array(EvidenceRefSchema).default([]),
  })
  .describe('A check whose outcome could not be determined');
export type UndeterminedCheck = z.infer<typeof UndeterminedCheckSchema>;
