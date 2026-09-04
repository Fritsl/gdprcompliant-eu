import { z } from 'zod';
import { EvidenceRefSchema } from './evidence.js';
import { FindingTypeIdSchema, HostnameSchema } from './primitives.js';

// The three-pass diff (S-05): what each third-party host did on the first load, after a
// refusal, and after an acceptance, and what that means. A host is "tracking" on the
// strength of what it was seen doing — setting or reading identifiers, reporting
// pageviews, loading pixels — never on a list of names alone. The findings the diff
// raises name the exact hosts and carry the diff itself as evidence.

export const HOST_ROLES = ['first-party', 'consent-platform', 'tracking', 'other'] as const;
export const HostRoleSchema = z.enum(HOST_ROLES);
export type HostRole = z.infer<typeof HostRoleSchema>;

export const HostDiffSchema = z.object({
  host: HostnameSchema,
  role: HostRoleSchema,
  // Why the host counts as tracking, in words a reader can check against the capture.
  signals: z.array(z.string()),
  onFirstLoad: z.boolean(),
  afterRefusal: z.boolean(),
  afterAcceptance: z.boolean(),
  // Cookies and storage keys this host's activity left behind, per pass.
  identifiers: z.object({
    a: z.array(z.string()),
    b: z.array(z.string()),
    c: z.array(z.string()),
  }),
});
export type HostDiff = z.infer<typeof HostDiffSchema>;

export const PassDiffSchema = z
  .object({
    site: HostnameSchema,
    hosts: z.array(HostDiffSchema),
    // The tracking hosts contacted before anyone was asked anything.
    beforeInteraction: z.array(HostnameSchema),
    // The tracking hosts contacted both after a refusal and after an acceptance.
    ignoringRefusal: z.array(HostnameSchema),
    // The tracking hosts the site does gate: after acceptance only.
    gated: z.array(HostnameSchema),
    refusal: z.object({
      made: z.boolean(),
      outcome: z.string(),
      interactions: z.number().int().min(0),
      togglesOff: z.number().int().min(0),
      layers: z.number().int().min(0),
      remembered: z.boolean(),
    }),
  })
  .describe('What the three passes showed, host by host');
export type PassDiff = z.infer<typeof PassDiffSchema>;

export const ConsentFindingDraftSchema = z.object({
  typeId: FindingTypeIdSchema,
  hosts: z.array(HostnameSchema),
  summary: z.string().min(1),
  evidence: z.array(EvidenceRefSchema).min(1),
});
export type ConsentFindingDraft = z.infer<typeof ConsentFindingDraftSchema>;

export const CONSENT_FINDINGS = {
  beforeInteraction: 'CNS-01',
  refusalIgnored: 'CNS-02',
  noRefusalPath: 'CNS-03',
  choiceNotRemembered: 'CNS-04',
  noRejectOnFirstLayer: 'CNS-05',
  preTickedToggles: 'CNS-06',
  refusalBuried: 'CNS-07',
} as const;
