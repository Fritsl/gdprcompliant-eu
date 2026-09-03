import { z } from 'zod';
import { ArtefactKindSchema } from './remedy.js';
import { SeveritySchema } from './finding.js';
import {
  CaseIdSchema,
  CountryCodeSchema,
  FindingTypeIdSchema,
  HostnameSchema,
  IdSchema,
  IsoDateTimeSchema,
  JurisdictionSchema,
  LocaleSchema,
  NonEmptyStringSchema,
  TenantIdSchema,
  UrlSchema,
} from './primitives.js';

export const CompanySchema = z
  .object({
    domain: HostnameSchema,
    legalName: z.string().optional(),
    country: CountryCodeSchema,
    locale: LocaleSchema,
    sector: z.string().optional(),
    sectorCode: z.string().optional().describe('NACE code, e.g. 47.91.10'),
    headcountBand: z.string().optional(),
    registry: z.string().optional().describe('Business register the entity was resolved in'),
    registryId: z.string().optional(),
    sellsService: z.boolean().optional(),
    entities: z.number().int().min(1).optional(),
  })
  .describe('The company a case is about');
export type Company = z.infer<typeof CompanySchema>;

export const CASE_LANES = ['self-serve', 'human'] as const;
export const CaseLaneSchema = z.enum(CASE_LANES);
export type CaseLane = z.infer<typeof CaseLaneSchema>;

export const CASE_STAGES = ['opened', 'assessed', 'working', 'documented', 'watched'] as const;
export const CaseStageSchema = z.enum(CASE_STAGES);
export type CaseStage = z.infer<typeof CaseStageSchema>;

export const CaseSchema = z
  .object({
    id: CaseIdSchema,
    tenantId: TenantIdSchema,
    company: CompanySchema,
    jurisdiction: JurisdictionSchema,
    locale: LocaleSchema,
    openedAt: IsoDateTimeSchema,
    owner: z.object({ name: NonEmptyStringSchema, role: z.string().optional() }).optional(),
    participants: z.number().int().min(0),
    watched: z.boolean(),
    lane: CaseLaneSchema,
    laneScore: z.number().int().min(0).max(100),
    stage: CaseStageSchema,
  })
  .describe('A numbered, shareable case');
export type Case = z.infer<typeof CaseSchema>;

// Every event names its actor: a person, an agent, or the machinery (C-02).
export const ActorSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('person'), userId: IdSchema, name: NonEmptyStringSchema }),
    z.object({
      kind: z.literal('agent'),
      name: NonEmptyStringSchema,
      model: z.string().optional(),
    }),
    z.object({ kind: z.literal('scanner') }),
    z.object({ kind: z.literal('watcher') }),
    z.object({ kind: z.literal('system') }),
  ])
  .describe('Who did it');
export type Actor = z.infer<typeof ActorSchema>;

const eventBase = {
  id: IdSchema,
  tenantId: TenantIdSchema,
  caseId: CaseIdSchema,
  // Strictly increasing within a case. The table is append-only; ordering is by seq, not
  // by clock.
  seq: z.number().int().min(1),
  at: IsoDateTimeSchema,
  actor: ActorSchema,
};

function event<T extends string, P extends z.ZodRawShape>(type: T, payload: P) {
  return z.object({ ...eventBase, type: z.literal(type), payload: z.object(payload) });
}

// The closed enum of timeline events. Adding one is a change to this file and nowhere else.
export const CaseEventSchema = z
  .discriminatedUnion('type', [
    event('case_opened', { source: z.enum(['scanner', 'invite', 'internal']) }),
    event('scan_started', { scanId: IdSchema, kind: z.enum(['initial', 'recheck', 'watch']) }),
    event('scan_completed', {
      scanId: IdSchema,
      checksRun: z.number().int().min(0),
      checksPassed: z.number().int().min(0),
      findings: z.number().int().min(0),
      undetermined: z.number().int().min(0),
    }),
    event('scan_failed', {
      scanId: IdSchema,
      reason: z.enum(['unreachable', 'timeout', 'blocked', 'error']),
      detail: z.string().optional(),
    }),
    event('finding_raised', {
      findingId: IdSchema,
      typeId: FindingTypeIdSchema,
      severity: SeveritySchema,
    }),
    event('finding_closed', {
      findingId: IdSchema,
      verifiedBy: z.enum(['rescan', 'artefact_published', 'attestation', 'answer']),
    }),
    event('finding_regressed', { findingId: IdSchema }),
    event('fix_verification_failed', { findingId: IdSchema, detail: z.string().optional() }),
    event('check_undetermined', { typeId: FindingTypeIdSchema, reason: NonEmptyStringSchema }),
    event('question_asked', { questionId: IdSchema }),
    event('question_answered', { questionId: IdSchema, answer: NonEmptyStringSchema }),
    event('artefact_generated', { artefactId: IdSchema, kind: ArtefactKindSchema }),
    event('artefact_published', {
      artefactId: IdSchema,
      kind: ArtefactKindSchema,
      url: UrlSchema.optional(),
    }),
    event('colleague_invited', { role: NonEmptyStringSchema }),
    event('colleague_joined', { role: NonEmptyStringSchema }),
    event('reminder_sent', { role: NonEmptyStringSchema }),
    event('watch_run', { scanId: IdSchema, changes: z.number().int().min(0) }),
    event('meeting_requested', { topic: z.string().optional() }),
    event('note_added', { text: NonEmptyStringSchema }),
    event('claim_rejected', { claimId: IdSchema, reason: NonEmptyStringSchema }),
    event('vendor_resolved', {
      vendorId: IdSchema,
      resolution: z.enum(['resolved', 'unresolved', 'ambiguous']),
    }),
  ])
  .describe('An immutable timeline event');
export type CaseEvent = z.infer<typeof CaseEventSchema>;
export type CaseEventType = CaseEvent['type'];

export const CASE_EVENT_TYPES = CaseEventSchema.options.map(
  (o) => o.shape.type.value,
) as readonly CaseEventType[];
