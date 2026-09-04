import { z } from 'zod';
import { CitationSchema } from './citation.js';
import { EvidenceRefSchema } from './evidence.js';
import {
  FindingTypeIdSchema,
  IsoDateTimeSchema,
  JurisdictionSchema,
  LocaleSchema,
  LocalisedTextSchema,
  NonEmptyStringSchema,
  Sha256Schema,
} from './primitives.js';

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

// What a policy must tell the reader (S-10): the elements of Article 13 as content, each
// with the provision it rests on and the finding raised when it is missing, where the
// catalogue has one. packages/findings/content/disclosures.json.
export const DisclosureElementSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]*$/),
  label: LocalisedTextSchema,
  // What the model is asked to look for, in one line.
  asks: NonEmptyStringSchema,
  citation: z.object({
    instrument: NonEmptyStringSchema,
    ref: NonEmptyStringSchema,
    note: z.string().optional(),
  }),
  findingTypeId: FindingTypeIdSchema.nullable(),
});
export type DisclosureElement = z.infer<typeof DisclosureElementSchema>;

export const DisclosureTableSchema = z
  .object({ version: z.number().int().min(1), elements: z.array(DisclosureElementSchema).min(1) })
  .superRefine((t, ctx) => {
    const seen = new Set<string>();
    t.elements.forEach((e, i) => {
      if (seen.has(e.id))
        ctx.addIssue({ code: 'custom', path: ['elements', i], message: `${e.id} twice` });
      seen.add(e.id);
    });
  });
export type DisclosureTable = z.infer<typeof DisclosureTableSchema>;

export const CLAUSE_STATUSES = ['present', 'absent', 'undetermined'] as const;
export const ClauseStatusSchema = z.enum(CLAUSE_STATUSES);
export type ClauseStatus = z.infer<typeof ClauseStatusSchema>;

// One element's verdict: present with the clause quoted verbatim, absent, or
// undetermined. The citation is the table's, never the model's.
export const ClauseResultSchema = z
  .object({
    element: NonEmptyStringSchema,
    status: ClauseStatusSchema,
    quote: z.string().min(1).optional(),
    note: z.string().optional(),
    citation: CitationSchema,
    findingTypeId: FindingTypeIdSchema.nullable(),
  })
  .superRefine((c, ctx) => {
    if (c.status === 'present' && c.quote === undefined) {
      ctx.addIssue({ code: 'custom', path: ['quote'], message: 'a present clause is quoted' });
    }
    if (c.status !== 'present' && c.quote !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['quote'],
        message: 'only a present clause carries a quote',
      });
    }
  });
export type ClauseResult = z.infer<typeof ClauseResultSchema>;

export const ClauseAnalysisSchema = z
  .object({
    documentHash: Sha256Schema,
    jurisdiction: JurisdictionSchema,
    locale: LocaleSchema,
    clauses: z.array(ClauseResultSchema).min(1),
    // Findings to raise: one per absent element the catalogue has a type for.
    drafts: z.array(
      z.object({
        typeId: FindingTypeIdSchema,
        element: NonEmptyStringSchema,
        evidence: z.array(EvidenceRefSchema).min(1),
      }),
    ),
    undetermined: z.array(NonEmptyStringSchema),
  })
  .describe('A policy checked clause by clause against Article 13');
export type ClauseAnalysis = z.infer<typeof ClauseAnalysisSchema>;
