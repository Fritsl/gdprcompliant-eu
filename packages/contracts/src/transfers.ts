import { z } from 'zod';
import { CountryCodeSchema, IsoDateTimeSchema, NonEmptyStringSchema } from './primitives.js';

// Transfer and jurisdiction determination (S-08). For a resolved recipient: where the
// contracting entity and its parent sit against the EEA, whether the Commission lists
// the country as adequate, whether the vendor is on the Data Privacy Framework list on
// the day it was looked up, and whether the scanned policy names a Chapter V basis.
// Every field is a fact with a date; the wording built from them says where things
// are, never whether using a named company is lawful (O-03).

const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const AdequacyListSchema = z.object({
  version: DateSchema,
  source: z.url(),
  verifiedAt: IsoDateTimeSchema,
  reviewBy: DateSchema,
  decisions: z.array(
    z.object({
      country: CountryCodeSchema,
      name: NonEmptyStringSchema,
      // When the decision covers part of a country's economy, or only certified
      // organisations, that limit as the Commission states it.
      scope: z.string().optional(),
      // The decision reaches only organisations on the Data Privacy Framework list.
      dpf: z.boolean().optional(),
    }),
  ),
});
export type AdequacyList = z.infer<typeof AdequacyListSchema>;

export const DPF_STATUSES = ['active', 'inactive', 'not_listed', 'not_checked'] as const;
export const DpfStatusSchema = z.enum(DPF_STATUSES);
export type DpfStatus = z.infer<typeof DpfStatusSchema>;

export const DpfLookupSchema = z
  .object({
    vendorId: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
    organisation: NonEmptyStringSchema.optional(),
    status: DpfStatusSchema,
    lookedUpAt: DateSchema.optional(),
  })
  .refine(
    (l) =>
      l.status === 'not_checked' ||
      (l.organisation !== undefined && l.lookedUpAt !== undefined) ||
      l.status === 'not_listed',
    {
      message: 'a lookup that found the organisation names it and the day it was looked up',
    },
  )
  .refine((l) => l.status !== 'not_listed' || l.lookedUpAt !== undefined, {
    message: 'a lookup that found nothing still names the day it was made',
  });
export type DpfLookup = z.infer<typeof DpfLookupSchema>;

export const DpfLookupsSchema = z
  .object({
    version: DateSchema,
    source: z.url(),
    lookups: z.array(DpfLookupSchema),
  })
  .superRefine((d, ctx) => {
    const seen = new Set<string>();
    d.lookups.forEach((l, i) => {
      if (seen.has(l.vendorId))
        ctx.addIssue({ code: 'custom', path: ['lookups', i], message: `duplicate ${l.vendorId}` });
      seen.add(l.vendorId);
    });
  });
export type DpfLookups = z.infer<typeof DpfLookupsSchema>;

export const TRANSFER_SITUATIONS = [
  // Contracting entity and parent both established in the EEA.
  'inside_eea',
  // Contracting entity in the EEA, parent outside it: hosted here, controlled from there.
  'eea_entity_non_eea_parent',
  // Contracting entity outside the EEA.
  'non_eea_entity',
] as const;
export const TransferSituationSchema = z.enum(TRANSFER_SITUATIONS);
export type TransferSituation = z.infer<typeof TransferSituationSchema>;

export const POLICY_BASIS = ['named', 'not_named', 'no_policy'] as const;
export const PolicyBasisSchema = z.enum(POLICY_BASIS);

const PlaceSchema = z.object({
  name: NonEmptyStringSchema,
  country: CountryCodeSchema,
  inEea: z.boolean(),
});

export const TransferDeterminationSchema = z.object({
  vendorId: z.string(),
  situation: TransferSituationSchema,
  contracting: PlaceSchema,
  parent: PlaceSchema,
  // The country outside the EEA the question is about, and what the Commission's list
  // says of it on the date read. Absent when both entities are inside the EEA.
  adequacy: z
    .object({
      country: CountryCodeSchema,
      listed: z.boolean(),
      scope: z.string().optional(),
      verifiedAt: IsoDateTimeSchema,
    })
    .optional(),
  // The Data Privacy Framework list, for a United States entity.
  dpf: z
    .object({
      status: DpfStatusSchema,
      organisation: z.string().optional(),
      lookedUpAt: DateSchema.optional(),
      source: z.url(),
    })
    .optional(),
  policyBasis: z.object({
    outcome: PolicyBasisSchema,
    // The Chapter V terms found in the policy, as written there.
    terms: z.array(z.string()).default([]),
  }),
  // The factual statement, per locale: where things are, with dates.
  statement: z.object({ en: z.string().min(1), da: z.string().min(1) }),
  registryVersions: z.object({
    vendors: z.string(),
    adequacy: z.string(),
    dpf: z.string(),
  }),
});
export type TransferDetermination = z.infer<typeof TransferDeterminationSchema>;
