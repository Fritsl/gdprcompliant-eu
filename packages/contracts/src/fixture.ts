import { z } from 'zod';
import { ConsentOutcomeSchema, ConsentPlatformSchema } from './consent.js';
import { FindingTypeIdSchema, HostnameSchema, NonEmptyStringSchema } from './primitives.js';

// A fixture site is a deliberately broken website under fixtures/sites/<name>/, served
// locally with every third party it loads simulated by another local host. Its
// expected.json names exactly which findings must appear and which must not: the
// ground truth the scanner is measured against (F-07, T-01).

// A per-host override for one path: a redirect, a header, a status. Lives in
// hosts/<host>/_routes.json.
export const FixtureRouteSchema = z.object({
  path: z.string().startsWith('/'),
  // Answer only on one scheme, e.g. an http-only redirect to https.
  scheme: z.enum(['http', 'https']).optional(),
  status: z.number().int().min(200).max(599).default(200),
  headers: z.record(z.string(), z.string()).default({}),
  body: z.string().optional(),
});
export type FixtureRoute = z.infer<typeof FixtureRouteSchema>;

// hosts/<host>/_routes.json
export const FixtureRoutesFileSchema = z.array(FixtureRouteSchema);

// hosts/<host>/_headers.json: response headers added to every answer from that host.
export const FixtureHeadersFileSchema = z.record(z.string().min(1), z.string());

export const FixtureNetworkExpectationSchema = z.object({
  mustContact: z.array(HostnameSchema).default([]),
  mustNotContact: z.array(HostnameSchema).default([]),
});
export type FixtureNetworkExpectation = z.infer<typeof FixtureNetworkExpectationSchema>;

// The awkward cases a fixture isolates (T-01), as a closed vocabulary so the suite can
// prove each one is covered.
export const FIXTURE_TAGS = [
  'clean',
  'lazy-load',
  'shadow-dom',
  'iframe',
  'spa',
  'local-storage-consent',
  'cloaking',
  // Instructions planted in the content, on every surface a model might read (A-10).
  'injection',
] as const;
export const FixtureTagSchema = z.enum(FIXTURE_TAGS);

export const FixtureExpectationSchema = z
  .object({
    // The customer's own host; the one the scan is pointed at.
    site: HostnameSchema,
    description: NonEmptyStringSchema,
    tags: z.array(FixtureTagSchema).default([]),
    findings: z
      .object({
        must: z.array(FindingTypeIdSchema).default([]),
        mustNot: z.array(FindingTypeIdSchema).default([]),
      })
      .refine((f) => f.must.every((id) => !f.mustNot.includes(id)), {
        message: 'a finding cannot be both required and forbidden',
      }),
    // Which hosts the browser contacts, per pass. firstLoad is pass A; afterReject and
    // afterAccept are passes B and C once S-03 and S-04 can drive the banner.
    network: z
      .object({
        firstLoad: FixtureNetworkExpectationSchema.prefault({}),
        afterReject: FixtureNetworkExpectationSchema.optional(),
        afterAccept: FixtureNetworkExpectationSchema.optional(),
      })
      .prefault({}),
    // What refusing consent on the site must look like (S-03).
    consent: z
      .object({
        platform: ConsentPlatformSchema,
        outcome: ConsentOutcomeSchema,
        minSteps: z.number().int().min(1).optional(),
        maxSteps: z.number().int().min(1).optional(),
        findingTypeId: FindingTypeIdSchema.optional(),
        rememberedAfterReload: z.boolean().optional(),
      })
      .optional(),
  })
  .describe('What a fixture site must and must not produce');
export type FixtureExpectation = z.infer<typeof FixtureExpectationSchema>;
