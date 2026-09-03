import { z } from 'zod';
import { InstrumentIdSchema, type ProvisionCitation } from './citation.js';
import {
  IsoDateTimeSchema,
  JurisdictionSchema,
  NonEmptyStringSchema,
  Sha256Schema,
  UrlSchema,
} from './primitives.js';

// The corpus (A-08): regulation, recitals, guidance and decisions cut into chunks that
// each carry the identifiers a citation needs, so a citation resolves to exactly one
// chunk or fails. Union instruments are jurisdiction 'EU' and speak in every member
// state; a national instrument speaks only in its own. Every chunk carries the corpus
// version it came from, and every legal claim records the version it was checked
// against, so an old finding stays explicable after the corpus moves on.

// The embedding width the corpus table is declared with; the model behind
// MODEL_EMBEDDING must produce it, and the ingest refuses anything else.
export const CORPUS_EMBEDDING_DIMENSIONS = 1024;

export const CORPUS_CHUNK_KINDS = ['article', 'recital', 'guidance', 'decision'] as const;
export const CorpusChunkKindSchema = z.enum(CORPUS_CHUNK_KINDS);
export type CorpusChunkKind = z.infer<typeof CorpusChunkKindSchema>;

// A corpus version is the date the content was last cut, plus a short tag.
export const CorpusVersionSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(\.[a-z0-9-]+)?$/, 'corpus version, e.g. 2026-09-04 or 2026-09-04.gdpr')
  .describe('Corpus version');
export type CorpusVersion = z.infer<typeof CorpusVersionSchema>;

export const CorpusChunkSchema = z
  .object({
    id: NonEmptyStringSchema,
    corpusVersion: CorpusVersionSchema,
    instrument: InstrumentIdSchema,
    // 'EU' for Union law; a country code for a national instrument.
    jurisdiction: JurisdictionSchema,
    kind: CorpusChunkKindSchema,
    article: z.string().regex(/^\d+[a-z]?$/),
    paragraph: z.string().regex(/^\d+$/).optional(),
    point: z
      .string()
      .regex(/^[a-z]+$/)
      .optional(),
    heading: z.string().optional(),
    text: NonEmptyStringSchema,
    hash: Sha256Schema,
    source: z.object({ url: UrlSchema, retrievedAt: IsoDateTimeSchema }),
  })
  .describe('One paragraph-sized piece of the corpus, addressable by citation');
export type CorpusChunk = z.infer<typeof CorpusChunkSchema>;

// The key a provision citation resolves by. The same shape as citationKey() for
// provisions, so a citation and a chunk meet on equal terms.
export function chunkKey(
  c: Pick<CorpusChunk, 'instrument' | 'article' | 'paragraph' | 'point'>,
): string {
  const parts = [c.instrument, c.article];
  if (c.paragraph !== undefined) parts.push(c.paragraph);
  if (c.point !== undefined) parts.push(c.point);
  return parts.join(':');
}

export const provisionKey = (c: ProvisionCitation): string =>
  chunkKey({
    instrument: c.instrument,
    article: c.article,
    paragraph: c.paragraph,
    point: c.point,
  });

// A curated instrument file: what sits in packages/corpus/content/<instrument>.json.
export const CorpusDocumentSchema = z
  .object({
    instrument: InstrumentIdSchema,
    title: NonEmptyStringSchema,
    jurisdiction: JurisdictionSchema,
    version: CorpusVersionSchema,
    source: z.object({ url: UrlSchema, retrievedAt: IsoDateTimeSchema }),
    chunks: z
      .array(
        z.object({
          kind: CorpusChunkKindSchema.default('article'),
          article: z.string().regex(/^\d+[a-z]?$/),
          paragraph: z.string().regex(/^\d+$/).optional(),
          point: z
            .string()
            .regex(/^[a-z]+$/)
            .optional(),
          heading: z.string().optional(),
          text: NonEmptyStringSchema,
        }),
      )
      .min(1),
  })
  .superRefine((d, ctx) => {
    const seen = new Set<string>();
    d.chunks.forEach((c, i) => {
      const key = chunkKey({ instrument: d.instrument, ...c });
      if (seen.has(key)) {
        ctx.addIssue({ code: 'custom', path: ['chunks', i], message: `duplicate chunk ${key}` });
      }
      seen.add(key);
    });
  })
  .describe('An instrument as curated content, cut into addressable chunks');
export type CorpusDocument = z.infer<typeof CorpusDocumentSchema>;

export const RESOLUTION_FAILURES = [
  'unknown_instrument',
  'no_such_paragraph',
  'wrong_jurisdiction',
  'unsupported_kind',
] as const;

export const CitationResolutionSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), chunk: CorpusChunkSchema, corpusVersion: CorpusVersionSchema }),
  z.object({
    ok: z.literal(false),
    reason: z.enum(RESOLUTION_FAILURES),
    detail: NonEmptyStringSchema,
  }),
]);
export type CitationResolution = z.infer<typeof CitationResolutionSchema>;
