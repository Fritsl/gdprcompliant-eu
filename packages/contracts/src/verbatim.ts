import { createHash } from 'node:crypto';
import { z } from 'zod';
import { InstrumentIdSchema } from './citation.js';
import {
  IsoDateTimeSchema,
  JurisdictionSchema,
  NonEmptyStringSchema,
  UrlSchema,
} from './primitives.js';

// Verbatim law (V-03). A quotation is a paragraph of the corpus fetched by its
// identifier and carried whole: instrument, article, paragraph and point, the text,
// the hash the text was cut with, the corpus version, and the date the consolidated
// text speaks from. Nothing here takes text from a model; the check below compares a
// rendered string with the entry character for character and names what went wrong,
// so a shortened, dotted or annotated quotation fails instead of degrading quietly.

export const TextDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'a date, YYYY-MM-DD')
  .describe('The date a consolidated text speaks from');

export const QuotationSchema = z
  .object({
    key: NonEmptyStringSchema,
    instrument: InstrumentIdSchema,
    article: z.string().regex(/^\d+[a-z]?$/),
    paragraph: z.string().regex(/^\d+$/).optional(),
    point: z
      .string()
      .regex(/^[a-z]+$/)
      .optional(),
    // How the reference reads: "GDPR Art. 28(3)(a)".
    ref: NonEmptyStringSchema,
    jurisdiction: JurisdictionSchema,
    text: NonEmptyStringSchema,
    hash: z.string().regex(/^[0-9a-f]{64}$/),
    corpusVersion: NonEmptyStringSchema,
    textAsOf: TextDateSchema,
    source: z.object({ url: UrlSchema, retrievedAt: IsoDateTimeSchema }),
  })
  .describe('A paragraph of law, fetched by identifier and carried whole');
export type Quotation = z.infer<typeof QuotationSchema>;

// The hash a chunk is cut with: the key and the text, so a paragraph moved under
// another number does not keep its hash.
export const quotationHash = (key: string, text: string): string =>
  createHash('sha256').update(`${key}\n${text}`).digest('hex');

export type VerbatimReason = 'hash' | 'ellipsis' | 'annotation' | 'truncated' | 'differs';

export interface VerbatimFailure {
  readonly ok: false;
  readonly reason: VerbatimReason;
  readonly detail: string;
  // Where the rendered string first departs from the entry, when that is the problem.
  readonly at?: number;
}
export type VerbatimResult = { readonly ok: true } | VerbatimFailure;

const ELLIPSIS = /…|\.\.\.|\[\s*(?:…|\.\.\.)\s*\]|\(\s*(?:…|\.\.\.)\s*\)/g;
const BRACKETED = /\[[^\]]*\]/g;

const foreign = (pattern: RegExp, rendered: string, text: string): string | undefined => {
  for (const m of rendered.matchAll(pattern)) if (!text.includes(m[0])) return m[0];
  return undefined;
};

const window = (s: string, at: number): string =>
  JSON.stringify(s.slice(Math.max(0, at - 12), at + 12));

// The rendered string against the entry, character for character. The entry itself
// is checked against its hash first: a quotation whose text was altered after it was
// cut is not an entry any more.
export function verbatim(rendered: string, q: Quotation): VerbatimResult {
  if (quotationHash(q.key, q.text) !== q.hash)
    return {
      ok: false,
      reason: 'hash',
      detail: `${q.key} at ${q.corpusVersion}: the text does not match the hash it was cut with`,
    };
  if (rendered === q.text) return { ok: true };
  const dots = foreign(ELLIPSIS, rendered, q.text);
  if (dots !== undefined)
    return {
      ok: false,
      reason: 'ellipsis',
      detail: `${q.key}: ${JSON.stringify(dots)} is not in the entry`,
    };
  const note = foreign(BRACKETED, rendered, q.text);
  if (note !== undefined)
    return {
      ok: false,
      reason: 'annotation',
      detail: `${q.key}: ${JSON.stringify(note)} is not in the entry`,
    };
  if (rendered.length < q.text.length && q.text.includes(rendered))
    return {
      ok: false,
      reason: 'truncated',
      detail: `${q.key}: ${rendered.length} of ${q.text.length} characters`,
    };
  let at = 0;
  while (at < rendered.length && at < q.text.length && rendered[at] === q.text[at]) at += 1;
  return {
    ok: false,
    reason: 'differs',
    detail: `${q.key}: differs at ${at}: rendered ${window(rendered, at)}, entry ${window(q.text, at)}`,
    at,
  };
}

export interface Excerpt {
  readonly ok: true;
  readonly start: number;
  readonly end: number;
}

// A span quoted out of a paragraph: contiguous, verbatim, no dots or notes of its own.
// The span is marked inside the whole paragraph, never shown instead of it.
export function excerptOf(q: Quotation, span: string): Excerpt | VerbatimFailure {
  const whole = verbatim(q.text, q);
  if (!whole.ok) return whole;
  if (span.length === 0) return { ok: false, reason: 'differs', detail: `${q.key}: an empty span` };
  const dots = foreign(ELLIPSIS, span, q.text);
  if (dots !== undefined)
    return {
      ok: false,
      reason: 'ellipsis',
      detail: `${q.key}: ${JSON.stringify(dots)} is not in the entry`,
    };
  const note = foreign(BRACKETED, span, q.text);
  if (note !== undefined)
    return {
      ok: false,
      reason: 'annotation',
      detail: `${q.key}: ${JSON.stringify(note)} is not in the entry`,
    };
  const start = q.text.indexOf(span);
  if (start < 0)
    return {
      ok: false,
      reason: 'differs',
      detail: `${q.key}: ${window(span, 0)} is not a span of the entry`,
    };
  return { ok: true, start, end: start + span.length };
}
