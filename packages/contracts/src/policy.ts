import { z } from 'zod';
import { EvidenceRefSchema } from './evidence.js';
import { IsoDateTimeSchema, Sha256Schema } from './primitives.js';

// Policy discovery (S-09): where a site keeps its privacy policy, cookie policy and terms,
// how each was found, and the pages that make it up. Every page is stored as document
// evidence, so the clause analysis (S-10) quotes from something a hash can vouch for.

export const POLICY_KINDS = ['privacy', 'cookie', 'terms'] as const;
export const PolicyKindSchema = z.enum(POLICY_KINDS);
export type PolicyKind = z.infer<typeof PolicyKindSchema>;

export const POLICY_FOUND_BY = ['rel', 'link', 'well-known', 'alternate', 'subpage'] as const;
export const PolicyFoundBySchema = z.enum(POLICY_FOUND_BY);

export const PolicyPageSchema = z.object({
  url: z.string().min(1),
  finalUrl: z.string().min(1),
  status: z.number().int(),
  language: z.string().optional(),
  title: z.string().optional(),
  fetchedAt: IsoDateTimeSchema,
  // Hash of the visible text, which is what the evidence row stores.
  textHash: Sha256Schema,
  words: z.number().int().min(0),
  foundBy: PolicyFoundBySchema,
  evidence: EvidenceRefSchema,
});
export type PolicyPage = z.infer<typeof PolicyPageSchema>;

export const PolicyDocumentSchema = z
  .object({
    kind: PolicyKindSchema,
    // The entry page, then the pages that belong to it: sub-pages and language variants.
    pages: z.array(PolicyPageSchema).min(1),
  })
  .describe('One policy as found on a site, possibly across several pages');
export type PolicyDocument = z.infer<typeof PolicyDocumentSchema>;

// A site with no discoverable privacy policy is itself a finding.
export const NO_PRIVACY_POLICY_FINDING = 'POL-01' as const;

export const PolicyDiscoverySchema = z
  .object({
    site: z.string().min(1),
    startedAt: IsoDateTimeSchema,
    documents: z.array(PolicyDocumentSchema),
    missing: z.array(PolicyKindSchema),
    // How many pages were fetched looking; bounded, GET only, same site only.
    fetched: z.number().int().min(0),
    observation: z.object({
      findingTypeId: z.literal(NO_PRIVACY_POLICY_FINDING),
      outcome: z.enum(['pass', 'fail']),
      summary: z.string().min(1),
      evidence: z.array(EvidenceRefSchema).default([]),
    }),
  })
  .superRefine((d, ctx) => {
    const found = new Set(d.documents.map((x) => x.kind));
    for (const kind of d.missing) {
      if (found.has(kind)) {
        ctx.addIssue({
          code: 'custom',
          path: ['missing'],
          message: `${kind} is both found and missing`,
        });
      }
    }
    if ((d.observation.outcome === 'fail') !== d.missing.includes('privacy')) {
      ctx.addIssue({
        code: 'custom',
        path: ['observation'],
        message: 'the observation fails exactly when the privacy policy is missing',
      });
    }
  })
  .describe('What policy discovery found on a site');
export type PolicyDiscovery = z.infer<typeof PolicyDiscoverySchema>;
