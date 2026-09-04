import { z } from 'zod';
import { CitationSchema } from './citation.js';
import { EvidenceRefSchema } from './evidence.js';
import {
  IdSchema,
  IsoDateTimeSchema,
  JurisdictionSchema,
  LocaleSchema,
  NonEmptyStringSchema,
} from './primitives.js';

// The case-grounded advisor (V-02): an answer that holds two things at once, the actual
// case and the law, and keeps them apart. What the case says is a fact from the graph
// with the pointer that placed it there (stored evidence or a recorded answer); what the
// law says is a passage of the corpus, quoted verbatim, with a citation that resolves;
// the answer is the model's prose on top of those two and nothing else. Where the case
// holds no evidence on the question the advisor refuses, and says which question would
// settle it.

export const ADVICE_FACT_KINDS = ['finding', 'register', 'answer', 'vendor', 'scan'] as const;
export const AdviceFactKindSchema = z.enum(ADVICE_FACT_KINDS);
export type AdviceFactKind = z.infer<typeof AdviceFactKindSchema>;

// Where a fact came from: a stored evidence row, or an answer a person gave.
export const AdvicePointerSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('evidence'),
    evidenceId: IdSchema,
    hash: EvidenceRefSchema.shape.hash,
  }),
  z.object({ kind: z.literal('answer'), answerId: IdSchema, questionId: IdSchema }),
]);
export type AdvicePointer = z.infer<typeof AdvicePointerSchema>;

export const AdviceFactSchema = z.object({
  kind: AdviceFactKindSchema,
  label: NonEmptyStringSchema,
  value: NonEmptyStringSchema,
  pointer: AdvicePointerSchema,
});
export type AdviceFact = z.infer<typeof AdviceFactSchema>;

export const AdviceLawSchema = z.object({
  key: NonEmptyStringSchema,
  citation: CitationSchema,
  quote: NonEmptyStringSchema,
  corpusVersion: NonEmptyStringSchema,
});
export type AdviceLaw = z.infer<typeof AdviceLawSchema>;

export const AdviceRefusalSchema = z.object({
  reason: NonEmptyStringSchema,
  // The catalogue question whose answer would settle it, when one fits.
  question: z.object({ id: IdSchema, asks: NonEmptyStringSchema }).optional(),
});
export type AdviceRefusal = z.infer<typeof AdviceRefusalSchema>;

export const AdviceSchema = z
  .object({
    question: NonEmptyStringSchema,
    locale: LocaleSchema,
    jurisdiction: JurisdictionSchema,
    at: IsoDateTimeSchema,
    // The three things, kept apart.
    answer: NonEmptyStringSchema,
    caseSays: z.array(AdviceFactSchema),
    lawSays: z.array(AdviceLawSchema),
    refused: AdviceRefusalSchema.optional(),
    model: z.string().optional(),
  })
  .superRefine((a, ctx) => {
    if (!a.refused && a.caseSays.length === 0)
      ctx.addIssue({
        code: 'custom',
        path: ['caseSays'],
        message: 'an answer that is not a refusal rests on at least one fact of the case',
      });
    for (const [i, l] of a.lawSays.entries()) {
      if (
        l.citation.kind === 'provision' &&
        a.jurisdiction !== 'EU' &&
        l.citation.jurisdiction &&
        l.citation.jurisdiction !== 'EU' &&
        l.citation.jurisdiction !== a.jurisdiction
      )
        ctx.addIssue({
          code: 'custom',
          path: ['lawSays', i],
          message: 'law of another jurisdiction is not authority here',
        });
    }
  })
  .describe('An answer grounded in the case and the law, the two kept apart');
export type Advice = z.infer<typeof AdviceSchema>;
