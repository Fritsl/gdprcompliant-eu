import { z } from 'zod';
import { EvidenceRefSchema } from './evidence.js';
import { IsoDateTimeSchema, NonEmptyStringSchema } from './primitives.js';

// Consent banners (S-03): finding the banner, naming the platform where its markup gives
// it away, and clicking through to a genuine refusal however deep it is buried. Every
// step is recorded with a screenshot, so a refusal is something a person can replay.
// When no refusal can be found, that is said plainly and is itself a finding: a visitor
// who cannot say no has not been asked.

export const CONSENT_PLATFORMS = [
  'cookiebot',
  'onetrust',
  'usercentrics',
  'cookieinformation',
  'didomi',
  'quantcast',
  'klaro',
  'cookieyes',
  'trustarc',
  'complianz',
  'generic',
] as const;
export const ConsentPlatformSchema = z.enum(CONSENT_PLATFORMS);
export type ConsentPlatform = z.infer<typeof ConsentPlatformSchema>;

export const CONSENT_ACTIONS = ['found', 'click', 'toggle_off', 'save', 'hidden'] as const;
export const ConsentActionSchema = z.enum(CONSENT_ACTIONS);
export type ConsentAction = z.infer<typeof ConsentActionSchema>;

// One step of the path: what was done, to what, and the screenshot taken right after.
export const ConsentStepSchema = z.object({
  n: z.number().int().min(1),
  action: ConsentActionSchema,
  // The control's visible text or, failing that, its selector.
  target: NonEmptyStringSchema,
  frame: z.string().optional(),
  at: IsoDateTimeSchema,
  screenshot: EvidenceRefSchema,
});
export type ConsentStep = z.infer<typeof ConsentStepSchema>;

export const CONSENT_OUTCOMES = ['refused', 'no_banner', 'undetermined'] as const;
export const ConsentOutcomeSchema = z.enum(CONSENT_OUTCOMES);
export type ConsentOutcome = z.infer<typeof ConsentOutcomeSchema>;

// A banner that offers no way to refuse, or one whose refusal could not be completed,
// is this finding. It is raised only on "undetermined", never on a guess.
export const NO_REFUSAL_PATH_FINDING = 'CNS-03' as const;

export const ConsentRefusalSchema = z
  .object({
    url: z.string().min(1),
    startedAt: IsoDateTimeSchema,
    bannerFound: z.boolean(),
    platform: ConsentPlatformSchema.optional(),
    // How the banner was recognised: a platform signature or the heuristic.
    recognisedBy: z.enum(['signature', 'heuristic']).optional(),
    outcome: ConsentOutcomeSchema,
    // Why the outcome is what it is, in words a reader can check against the steps.
    summary: z.string().min(1),
    steps: z.array(ConsentStepSchema),
    // Whether the banner was gone after the last step; a refusal that leaves the
    // banner up did not take.
    bannerHiddenAfter: z.boolean(),
    finding: z
      .object({
        findingTypeId: z.literal(NO_REFUSAL_PATH_FINDING),
        evidence: z.array(EvidenceRefSchema).min(1),
      })
      .optional(),
  })
  .superRefine((r, ctx) => {
    if (r.bannerFound !== (r.platform !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['platform'],
        message: 'a found banner names its platform',
      });
    }
    if (r.outcome === 'no_banner' && r.bannerFound) {
      ctx.addIssue({
        code: 'custom',
        path: ['outcome'],
        message: 'no_banner means no banner was found',
      });
    }
    if (r.outcome === 'refused' && !r.bannerHiddenAfter) {
      ctx.addIssue({
        code: 'custom',
        path: ['outcome'],
        message: 'a refusal that leaves the banner up is undetermined',
      });
    }
    if ((r.outcome === 'undetermined') !== (r.finding !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['finding'],
        message: 'undetermined is the finding, and the only case that is',
      });
    }
  })
  .describe('The path taken to refuse consent on a page, with a screenshot per step');
export type ConsentRefusal = z.infer<typeof ConsentRefusalSchema>;
