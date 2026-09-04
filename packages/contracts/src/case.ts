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
  Sha256Schema,
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

// The characters a case number is drawn from (C-01): no 0/O, 1/I/L or U, so a number
// read aloud over the phone comes back the same. The id schema accepts the wider set
// because the design fixtures predate the rule.
export const CASE_NUMBER_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CASE_NUMBER_PATTERN = /^[A-Z]{2}-\d{2}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}$/;

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
    // An answer (D-10): the option as the person read it, the question in English for
    // the record, and how many duties the answer settled. Every version is an event.
    event('question_answered', {
      questionId: IdSchema,
      answer: NonEmptyStringSchema,
      question: NonEmptyStringSchema.optional(),
      settled: z.number().int().min(0).optional(),
    }),
    // "Check it for me": the question went to the agent as a job.
    event('check_requested', { questionId: IdSchema, jobId: NonEmptyStringSchema }),
    // One of us opened the case (L-02): on the record, where the customer sees it.
    event('internal_access', { name: NonEmptyStringSchema }),
    event('artefact_generated', { artefactId: IdSchema, kind: ArtefactKindSchema }),
    // A named person signed a specific version of a document (A-09): who, which version,
    // which bytes. Nothing is published or exported without one.
    event('artefact_signed', {
      artefactId: IdSchema,
      kind: ArtefactKindSchema,
      version: z.number().int().min(1),
      hash: Sha256Schema,
      by: NonEmptyStringSchema,
    }),
    event('artefact_published', {
      artefactId: IdSchema,
      kind: ArtefactKindSchema,
      url: UrlSchema.optional(),
    }),
    event('colleague_invited', { role: NonEmptyStringSchema }),
    event('colleague_joined', { role: NonEmptyStringSchema }),
    event('reminder_sent', { role: NonEmptyStringSchema }),
    // An invitation withdrawn by the owner (P-02): the link stops working.
    event('invitation_revoked', { role: NonEmptyStringSchema }),
    event('watch_run', { scanId: IdSchema, changes: z.number().int().min(0) }),
    event('meeting_requested', { topic: z.string().optional() }),
    event('note_added', { text: NonEmptyStringSchema }),
    // The visitor changed the language of the case (I-03); the target's own stays inferred.
    event('locale_overridden', { from: LocaleSchema, to: LocaleSchema }),
    event('claim_rejected', { claimId: IdSchema, reason: NonEmptyStringSchema }),
    // Ownership (C-01): a case opens with no account and is claimed later by proving
    // control of an address at the scanned domain, or by an explicit override.
    event('claim_requested', { claimId: IdSchema, email: NonEmptyStringSchema }),
    event('case_claimed', {
      method: z.enum(['email', 'override']),
      email: z.string().optional(),
      by: z.string().optional(),
      reason: z.string().optional(),
    }),
    event('case_expired', { unclaimedFor: z.number().int().min(0) }),
    // Proving the case is theirs (C-04): a full export, and a hard delete. The export
    // event stays on the timeline; the deletion event is the last thing written before
    // the record itself goes, and survives only in an export taken after it.
    event('export_produced', { bytes: z.number().int().min(0), sha256: z.string().length(64) }),
    event('deletion_requested', {
      requestedBy: z.enum(['token', 'owner', 'operator', 'retention']),
      reason: z.string().optional(),
    }),
    event('vendor_resolved', {
      vendorId: IdSchema,
      resolution: z.enum(['resolved', 'unresolved', 'ambiguous']),
    }),
    // The public progress page (U-05): on and off are explicit acts, both on the record.
    event('trust_published', { slug: NonEmptyStringSchema }),
    event('trust_unpublished', { slug: NonEmptyStringSchema }),
    // A share link (U-07): upward, to someone who needs one screen. Created and revoked
    // by the holder, both on the record.
    event('share_created', {
      shareId: IdSchema,
      kind: z.enum(['upward']),
      audience: z.string().optional(),
    }),
    event('share_revoked', { shareId: IdSchema, kind: z.enum(['upward']) }),
  ])
  .describe('An immutable timeline event');
export type CaseEvent = z.infer<typeof CaseEventSchema>;
export type CaseEventType = CaseEvent['type'];

export const CASE_EVENT_TYPES = CaseEventSchema.options.map(
  (o) => o.shape.type.value,
) as readonly CaseEventType[];
