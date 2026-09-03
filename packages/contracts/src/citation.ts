import { z } from 'zod';
import { JurisdictionSchema, NonEmptyStringSchema } from './primitives.js';

// A citation is a mechanical key into the corpus (A-08), never free text. The verifier
// (A-07) resolves it for the stated jurisdiction; an unresolvable citation rejects the
// claim that carried it. The human-readable `ref` is what the customer sees.

// Instrument identifiers are corpus ids: 'GDPR', 'ePrivacy', 'DK-DBL' and so on. The set
// grows with the corpus, so it is a pattern, not an enum.
export const InstrumentIdSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9-]{1,31}$/, 'corpus instrument id')
  .describe('Corpus instrument id, e.g. GDPR, ePrivacy');
export type InstrumentId = z.infer<typeof InstrumentIdSchema>;

const citationBase = {
  // Display form, e.g. "Art. 5(3)" or "C-673/17". Shown to the customer, never used for lookup.
  ref: NonEmptyStringSchema.describe('Display reference, e.g. Art. 5(3)'),
  note: z.string().optional().describe('Short plain-language gloss'),
  // A verbatim quote from the passage. The verifier checks it character for character.
  quote: z.string().optional().describe('Verbatim quote from the cited passage'),
};

export const ProvisionCitationSchema = z.object({
  kind: z.literal('provision'),
  instrument: InstrumentIdSchema,
  article: z
    .string()
    .regex(/^\d+[a-z]?$/)
    .describe('Article number, e.g. 5 or 13a'),
  paragraph: z.string().regex(/^\d+$/).optional(),
  point: z
    .string()
    .regex(/^[a-z]+$/)
    .optional(),
  subparagraph: z.string().regex(/^\d+$/).optional(),
  // Only national instruments carry a jurisdiction; Union instruments are jurisdiction-free.
  jurisdiction: JurisdictionSchema.optional(),
  ...citationBase,
});
export type ProvisionCitation = z.infer<typeof ProvisionCitationSchema>;

export const DecisionCitationSchema = z.object({
  kind: z.literal('decision'),
  // The court or authority, e.g. 'CJEU', 'Datatilsynet'.
  body: NonEmptyStringSchema,
  reference: NonEmptyStringSchema.describe('Case or decision number'),
  paragraph: z.string().regex(/^\d+$/).optional(),
  jurisdiction: JurisdictionSchema.optional(),
  ...citationBase,
});
export type DecisionCitation = z.infer<typeof DecisionCitationSchema>;

export const GuidanceCitationSchema = z.object({
  kind: z.literal('guidance'),
  authority: NonEmptyStringSchema,
  title: NonEmptyStringSchema,
  section: z.string().optional(),
  jurisdiction: JurisdictionSchema.optional(),
  ...citationBase,
});
export type GuidanceCitation = z.infer<typeof GuidanceCitationSchema>;

export const CitationSchema = z
  .discriminatedUnion('kind', [
    ProvisionCitationSchema,
    DecisionCitationSchema,
    GuidanceCitationSchema,
  ])
  .describe('A citation that resolves mechanically in the corpus');
export type Citation = z.infer<typeof CitationSchema>;

// The corpus lookup key. Two citations with the same key point at the same passage.
export function citationKey(c: Citation): string {
  switch (c.kind) {
    case 'provision': {
      const parts = [c.instrument, c.article];
      if (c.paragraph !== undefined) parts.push(c.paragraph);
      if (c.point !== undefined) parts.push(c.point);
      if (c.subparagraph !== undefined) parts.push(`sub${c.subparagraph}`);
      return parts.join(':');
    }
    case 'decision':
      return [c.body, c.reference, ...(c.paragraph !== undefined ? [c.paragraph] : [])].join(':');
    case 'guidance':
      return [c.authority, c.title, ...(c.section !== undefined ? [c.section] : [])].join(':');
  }
}

// Parse a display reference of the form "Art. 5(3)(a)" into a provision citation. This
// is how the phase 0 fixture's `{ instrument, ref }` pairs become real citations. A range
// such as "Art. 44–49" resolves to its first article; the display ref keeps the range.
const ARTICLE_REF =
  /^Art(?:icle|\.)?\s*(\d+[a-z]?)(?:[–-]\d+[a-z]?)?(?:\((\d+)\))?(?:\(([a-z]+)\))?$/i;

export function parseProvisionRef(
  instrument: string,
  ref: string,
  extra: { note?: string; jurisdiction?: string } = {},
): ProvisionCitation | undefined {
  const m = ARTICLE_REF.exec(ref.trim());
  if (!m || m[1] === undefined) return undefined;
  const candidate: Record<string, unknown> = {
    kind: 'provision',
    instrument,
    article: m[1],
    ref: ref.trim(),
  };
  if (m[2] !== undefined) candidate['paragraph'] = m[2];
  if (m[3] !== undefined) candidate['point'] = m[3];
  if (extra.note !== undefined) candidate['note'] = extra.note;
  if (extra.jurisdiction !== undefined) candidate['jurisdiction'] = extra.jurisdiction;
  const parsed = ProvisionCitationSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}
