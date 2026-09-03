import {
  provisionKey,
  type Citation,
  type CitationResolution,
  type CorpusChunk,
  type Jurisdiction,
} from '@gc/contracts';

// Resolution is a lookup, never a search. A provision citation names an instrument, an
// article and, where the citation goes that deep, a paragraph and a point; the chunk
// with exactly that key is the answer, and anything else is a failure with a reason.
// There is no nearest match: "Art. 5(4)" of an instrument whose article 5 has three
// paragraphs is no_such_paragraph, not paragraph 3.
//
// Jurisdiction is part of the lookup. Union law ('EU') resolves in every jurisdiction;
// a national instrument resolves only in its own, so a Danish act cited for a German
// case fails as wrong_jurisdiction rather than becoming authority across a border.

export const speaksIn = (chunkJurisdiction: string, jurisdiction: Jurisdiction): boolean =>
  chunkJurisdiction === 'EU' || chunkJurisdiction === jurisdiction;

export interface ResolveOptions {
  // Pin a corpus version; otherwise the newest version of the instrument answers.
  readonly corpusVersion?: string;
}

// Newest first, by the version string's natural order (dates sort as text).
export const newestVersion = (versions: Iterable<string>): string | undefined =>
  [...new Set(versions)].sort().at(-1);

export function resolveInChunks(
  chunks: readonly CorpusChunk[],
  citation: Citation,
  jurisdiction: Jurisdiction,
  options: ResolveOptions = {},
): CitationResolution {
  if (citation.kind !== 'provision') {
    return {
      ok: false,
      reason: 'unsupported_kind',
      detail: `${citation.kind} citations do not resolve to a corpus paragraph yet`,
    };
  }
  const key = provisionKey(citation);
  const ofInstrument = chunks.filter((c) => c.instrument === citation.instrument);
  if (ofInstrument.length === 0) {
    return {
      ok: false,
      reason: 'unknown_instrument',
      detail: `${citation.instrument} is not in the corpus`,
    };
  }
  const version = options.corpusVersion ?? newestVersion(ofInstrument.map((c) => c.corpusVersion));
  const atVersion = ofInstrument.filter((c) => c.corpusVersion === version);
  if (atVersion.length === 0) {
    return {
      ok: false,
      reason: 'unknown_instrument',
      detail: `${citation.instrument} has no corpus version ${version}`,
    };
  }
  const exact = atVersion.filter(
    (c) =>
      c.article === citation.article &&
      c.paragraph === citation.paragraph &&
      c.point === citation.point,
  );
  if (exact.length !== 1) {
    return {
      ok: false,
      reason: 'no_such_paragraph',
      detail:
        exact.length === 0
          ? `${key} is not a paragraph of ${citation.instrument} at ${version}`
          : `${key} matches ${exact.length} chunks at ${version}`,
    };
  }
  const chunk = exact[0]!;
  if (!speaksIn(chunk.jurisdiction, jurisdiction)) {
    return {
      ok: false,
      reason: 'wrong_jurisdiction',
      detail: `${citation.instrument} speaks in ${chunk.jurisdiction}, not ${jurisdiction}`,
    };
  }
  return { ok: true, chunk, corpusVersion: chunk.corpusVersion };
}
