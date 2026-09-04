import { z } from 'zod';
import { EvidenceRefSchema } from './evidence.js';
import { FindingTypeIdSchema } from './primitives.js';
import {
  CountryCodeSchema,
  HostnameSchema,
  IsoDateTimeSchema,
  NonEmptyStringSchema,
} from './primitives.js';

// Recipients (S-15): who else receives a visitor's requests, read from what the browser
// contacted. Two checks: a request to a host whose operator is established outside the
// EEA, and a web font fetched from a third party. Both are observations about traffic;
// neither says anything about a vendor beyond where the map says it is established.

export const RECIPIENT_CHECKS = {
  transfers: 'TRF-01',
  third_party_fonts: 'VND-06',
} as const;
export type RecipientCheckId = keyof typeof RECIPIENT_CHECKS;
export const RecipientCheckIdSchema = z.enum(
  Object.keys(RECIPIENT_CHECKS) as [RecipientCheckId, ...RecipientCheckId[]],
);

export const RecipientObservationSchema = z
  .object({
    check: RecipientCheckIdSchema,
    findingTypeId: FindingTypeIdSchema,
    outcome: z.enum(['pass', 'fail', 'undetermined']),
    summary: z.string().min(1),
    detail: z.record(z.string(), z.unknown()).default({}),
    // The third-party hosts the observation is about, for the finding to name.
    hosts: z.array(HostnameSchema).default([]),
    evidence: z.array(EvidenceRefSchema).default([]),
  })
  .superRefine((o, ctx) => {
    if (o.outcome === 'fail' && o.evidence.length === 0) {
      ctx.addIssue({ code: 'custom', message: 'a failed check names its evidence' });
    }
    if (o.findingTypeId !== RECIPIENT_CHECKS[o.check]) {
      ctx.addIssue({ code: 'custom', message: `${o.check} maps to ${RECIPIENT_CHECKS[o.check]}` });
    }
  });
export type RecipientObservation = z.infer<typeof RecipientObservationSchema>;

// The curated map from a request host to the operator behind it: where it is established,
// and where that was read. Everything not in the map is unknown, never guessed.
export const RecipientHostSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  name: NonEmptyStringSchema,
  jurisdiction: CountryCodeSchema,
  hostSuffixes: z.array(HostnameSchema).min(1),
  provenance: z.object({ url: z.url(), verifiedAt: IsoDateTimeSchema }),
});
export type RecipientHost = z.infer<typeof RecipientHostSchema>;

export const RecipientHostMapSchema = z.object({
  version: z.string().min(1),
  hosts: z.array(RecipientHostSchema),
});
export type RecipientHostMap = z.infer<typeof RecipientHostMapSchema>;

// The European Economic Area: where a transfer is not a transfer.
export const EEA = [
  'AT',
  'BE',
  'BG',
  'HR',
  'CY',
  'CZ',
  'DK',
  'EE',
  'FI',
  'FR',
  'DE',
  'GR',
  'HU',
  'IE',
  'IT',
  'LV',
  'LT',
  'LU',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SK',
  'SI',
  'ES',
  'SE',
  'IS',
  'LI',
  'NO',
] as const;
export const inEea = (country: string): boolean => (EEA as readonly string[]).includes(country);
