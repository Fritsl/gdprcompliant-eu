import { eq } from 'drizzle-orm';
import {
  QuotationSchema,
  chunkKey,
  verbatim,
  type Citation,
  type CitationResolution,
  type CorpusChunk,
  type Jurisdiction,
  type Quotation,
  type VerbatimResult,
} from '@gc/contracts';
import { schema, type Connection } from '@gc/db';
import { documentChunks, loadCorpusDocuments } from './content.js';
import { resolveInChunks, type ResolveOptions } from './resolve.js';
import { resolveCitation } from './store.js';

// Quotations (V-03): law fetched by identifier, from the content files or from the
// store, and never typed by anything else. A quotation carries the whole paragraph,
// the hash it was cut with, the corpus version and the date the text speaks from; a
// document without that date cannot be quoted, because an amended article shown
// without its date would read as current.

let cached: CorpusChunk[] | undefined;
export const corpusChunks = (): CorpusChunk[] =>
  (cached ??= loadCorpusDocuments().flatMap((d) => documentChunks(d)));

export const displayRef = (
  c: Pick<CorpusChunk, 'instrument' | 'article' | 'paragraph' | 'point'>,
): string => {
  let ref = `${c.instrument} Art. ${c.article}`;
  if (c.paragraph !== undefined) ref += `(${c.paragraph})`;
  if (c.point !== undefined) ref += `(${c.point})`;
  return ref;
};

export type QuotationResult =
  | { readonly ok: true; readonly quotation: Quotation }
  | {
      readonly ok: false;
      readonly reason: Extract<CitationResolution, { ok: false }>['reason'] | 'undated';
      readonly detail: string;
    };

export function quotationOf(chunk: CorpusChunk): QuotationResult {
  if (!chunk.source.textAsOf)
    return {
      ok: false,
      reason: 'undated',
      detail: `${chunk.instrument} at ${chunk.corpusVersion} does not say what date its text speaks from`,
    };
  const quotation = QuotationSchema.parse({
    key: chunkKey(chunk),
    instrument: chunk.instrument,
    article: chunk.article,
    ...(chunk.paragraph !== undefined ? { paragraph: chunk.paragraph } : {}),
    ...(chunk.point !== undefined ? { point: chunk.point } : {}),
    ref: displayRef(chunk),
    jurisdiction: chunk.jurisdiction,
    text: chunk.text,
    hash: chunk.hash,
    corpusVersion: chunk.corpusVersion,
    textAsOf: chunk.source.textAsOf,
    source: { url: chunk.source.url, retrievedAt: chunk.source.retrievedAt },
  });
  const check = verbatim(quotation.text, quotation);
  if (!check.ok) return { ok: false, reason: 'undated', detail: check.detail };
  return { ok: true, quotation };
}

const fromResolution = (r: CitationResolution): QuotationResult => {
  if (!r.ok) return { ok: false, reason: r.reason, detail: r.detail };
  if (!('chunk' in r))
    return { ok: false, reason: 'unsupported_kind', detail: 'resolved to no paragraph' };
  return quotationOf(r.chunk);
};

// By identifier, from the content files: exactly the paragraph cited or a failure.
export const quotation = (
  chunks: readonly CorpusChunk[],
  citation: Citation,
  jurisdiction: Jurisdiction,
  options: ResolveOptions = {},
): QuotationResult => fromResolution(resolveInChunks(chunks, citation, jurisdiction, options));

// By identifier, from the store.
export const quotationFromStore = async (
  connection: Connection,
  citation: Citation,
  jurisdiction: Jurisdiction,
  options: ResolveOptions = {},
): Promise<QuotationResult> =>
  fromResolution(await resolveCitation(connection, citation, jurisdiction, options));

// A quotation in hand against the store's entry at the same version, character for
// character: what a page is about to show is what was ingested, or it is not shown.
export async function confirmAgainstStore(
  connection: Connection,
  q: Quotation,
): Promise<VerbatimResult> {
  const rows = await connection.db
    .select()
    .from(schema.corpusChunks)
    .where(eq(schema.corpusChunks.hash, q.hash));
  const row = rows.find((r) => r.key === q.key && r.corpusVersion === q.corpusVersion);
  if (!row) {
    return {
      ok: false,
      reason: 'hash',
      detail: `${q.key} at ${q.corpusVersion} is not in the store with hash ${q.hash.slice(0, 12)}`,
    };
  }
  const stored = QuotationSchema.parse({
    ...q,
    text: row.text,
    hash: row.hash,
    textAsOf: row.textAsOf ?? q.textAsOf,
  });
  return verbatim(q.text, stored);
}
