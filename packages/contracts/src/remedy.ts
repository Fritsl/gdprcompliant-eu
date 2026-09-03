import { z } from 'zod';
import {
  CountryCodeSchema,
  FindingTypeIdSchema,
  IdSchema,
  IsoDateTimeSchema,
  JurisdictionSchema,
  LocaleSchema,
  LocalisedTextSchema,
  NonEmptyStringSchema,
  UrlSchema,
} from './primitives.js';

// A finding without a remedy cannot exist (R-02). Remedies are first-class content:
// kind, jurisdiction scope, effort, the actual instruction, and what closes the finding.
// The catalogue entry carries locale variants; the rendered remedy is the same shape in
// one locale, with case specifics substituted by the resolver (R-04). Both come from the
// single definition in `remedyShape`, so they cannot drift.

export const REMEDY_KINDS = [
  'self_fix',
  'generated_artefact',
  'our_product',
  'partner_alternative',
  'no_solution',
] as const;
export const RemedyKindSchema = z.enum(REMEDY_KINDS).describe('Exactly the five remedy kinds');
export type RemedyKind = z.infer<typeof RemedyKindSchema>;

export const ARTEFACT_KINDS = [
  'privacy_policy',
  'cookie_declaration',
  'processing_agreement',
  'processing_register',
  'sub_processor_list',
  'retention_schedule',
  'evidence_pack',
  'status_report',
] as const;
export const ArtefactKindSchema = z
  .enum(ARTEFACT_KINDS)
  .describe('A document the system can generate');
export type ArtefactKind = z.infer<typeof ArtefactKindSchema>;

// How "did this actually fix it" is decided, machine-checkably (R-01).
export const VerificationSchema = z
  .discriminatedUnion('method', [
    // Re-run the detector; the finding closes when it no longer fires.
    z.object({ method: z.literal('rescan') }),
    // The generated document exists and is published where the finding needs it.
    z.object({ method: z.literal('artefact_published'), artefact: ArtefactKindSchema }),
    // The customer confirms a fact the scanner cannot observe from outside.
    z.object({ method: z.literal('attestation'), statement: NonEmptyStringSchema }),
    // A specific question, answered, closes the finding.
    z.object({ method: z.literal('answer'), questionId: IdSchema }),
    // Nothing can verify it. Only no_solution remedies may say so, and they say why.
    z.object({ method: z.literal('none'), reason: NonEmptyStringSchema }),
  ])
  .describe('How closure is verified');
export type Verification = z.infer<typeof VerificationSchema>;

export const ProductIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,31}$/, 'product id, e.g. gdprchat')
  .describe('One of our own products, e.g. gdprchat, gdproffice');
export type ProductId = z.infer<typeof ProductIdSchema>;

// Every drafted message and prompt must be actionable in one click (smoke test rule), so
// an action is a closed set of shapes the UI knows how to render.
export function actionShape<T extends z.ZodType>(text: T) {
  return z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('agent_prompt'),
      label: text,
      body: text,
      forwardable: text.optional(),
    }),
    z.object({
      kind: z.literal('message'),
      label: text,
      to: text,
      subject: text,
      body: text,
    }),
    z.object({
      kind: z.literal('link'),
      label: text,
      url: UrlSchema,
    }),
  ]);
}

export function remedyShape<T extends z.ZodType, E extends z.ZodRawShape = Record<never, never>>(
  text: T,
  extra: E = {} as E,
) {
  const action = actionShape(text);
  const base = {
    ...extra,
    id: IdSchema,
    // The catalogue is versioned (R-01); a finding references a specific version.
    version: z.number().int().min(1),
    findingTypeId: FindingTypeIdSchema,
    // Which jurisdictions this remedy is valid in. 'all' for remedies that do not depend
    // on national law (a tag firing before consent is fixed the same way everywhere).
    jurisdictions: z.union([z.literal('all'), z.array(JurisdictionSchema).min(1)]),
    title: text,
    effort: z.object({
      label: text,
      minutes: z.number().int().positive().optional(),
    }),
    detail: text,
    verifyLabel: text.optional(),
    verification: VerificationSchema,
  };
  return z.discriminatedUnion('kind', [
    z.object({
      ...base,
      kind: z.literal('self_fix'),
      snippet: z.string().optional().describe('Code, not translated'),
      // A self-fix the customer cannot act on without translating it themselves is not a
      // remedy, so the action is mandatory here.
      action,
    }),
    z.object({
      ...base,
      kind: z.literal('generated_artefact'),
      artefact: ArtefactKindSchema,
      cta: text,
      action: action.optional(),
    }),
    z.object({
      ...base,
      kind: z.literal('our_product'),
      product: z.object({ id: ProductIdSchema, url: UrlSchema }),
      cta: text,
      alternativeNote: text.optional(),
      action: action.optional(),
    }),
    z.object({
      ...base,
      kind: z.literal('partner_alternative'),
      options: z
        .array(
          z.object({
            name: NonEmptyStringSchema,
            jurisdiction: CountryCodeSchema,
            note: text.optional(),
            url: UrlSchema.optional(),
          }),
        )
        .min(1),
      action: action.optional(),
    }),
    z.object({
      ...base,
      kind: z.literal('no_solution'),
      // The key this writes to the demand ledger under (R-05). Mandatory: a gap nobody
      // records is a gap nobody closes.
      demandGap: NonEmptyStringSchema,
      askLabel: text.optional(),
      action: action.optional(),
    }),
  ]);
}

// Catalogue entry: content with locale variants.
export const RemedySchema = remedyShape(LocalisedTextSchema).describe('A remedy catalogue entry');
export type Remedy = z.infer<typeof RemedySchema>;

// The same remedy rendered for one case in one locale. This is what the UI and the
// phase 0 fixture consume.
export const RenderedRemedySchema = remedyShape(z.string().min(1), {
  locale: LocaleSchema,
}).describe('A remedy rendered for one case and locale');
export type RenderedRemedy = z.infer<typeof RenderedRemedySchema>;

export const ActionSchema = actionShape(z.string().min(1)).describe('A one-click action');
export type Action = z.infer<typeof ActionSchema>;

export const RemedyRefSchema = z
  .object({
    remedyId: IdSchema,
    version: z.number().int().min(1),
  })
  .describe('Reference to a specific catalogue version');
export type RemedyRef = z.infer<typeof RemedyRefSchema>;

// The demand ledger (R-05): what customers needed that nobody offers.
export const DemandLedgerEntrySchema = z
  .object({
    gap: NonEmptyStringSchema,
    seen: z.number().int().min(0),
    sectors: z.union([z.literal('all'), z.array(NonEmptyStringSchema).min(1)]),
    answer: z.enum(['none', 'partial', 'ours']),
    firstSeenAt: IsoDateTimeSchema.optional(),
    lastSeenAt: IsoDateTimeSchema.optional(),
  })
  .describe('A recorded gap in the solution catalogue');
export type DemandLedgerEntry = z.infer<typeof DemandLedgerEntrySchema>;
