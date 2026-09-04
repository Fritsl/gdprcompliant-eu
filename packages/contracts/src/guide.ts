import { z } from 'zod';
import { FindingTypeIdSchema } from './primitives.js';
import { LocalisedTextSchema, NonEmptyStringSchema } from './primitives.js';

// A guide (S-15, R-03): one page per finding type, for a competent non-specialist. What
// is wrong, why it matters, exactly what to change, and how to confirm it worked. A
// structured object with every string localised, so Danish is a translation of the same
// object and never a separate document. The guide never quotes law itself; the binding
// for the reader's jurisdiction supplies the provisions, resolved in the corpus.

export const GuideIdSchema = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'guide slug')
  .describe('Guide content id, as bindings name it');
export type GuideId = z.infer<typeof GuideIdSchema>;

export const GuideSchema = z
  .object({
    id: GuideIdSchema,
    findingTypeId: FindingTypeIdSchema,
    // The page title: what is wrong, in plain words. Doubles as the search landing title.
    title: LocalisedTextSchema,
    // One paragraph: what the scanner saw and what it means for a visitor.
    wrong: LocalisedTextSchema,
    // One paragraph: why it matters to the company, in consequences a manager weighs.
    why: LocalisedTextSchema,
    // Exactly what to change, in order. Each step is one action.
    steps: z.array(LocalisedTextSchema).min(2),
    // How to confirm it worked, from outside, without trusting anyone's word.
    confirm: LocalisedTextSchema,
    // Words a person would search for; every locale carries its own.
    keywords: z.array(LocalisedTextSchema).default([]),
    // The remedy whose snippet the page shows, when there is one to show.
    remedyId: NonEmptyStringSchema.optional(),
  })
  .describe('A guide page for one finding type');
export type Guide = z.infer<typeof GuideSchema>;
