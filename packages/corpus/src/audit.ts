import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import {
  CitationSchema,
  citationKey,
  parseDecisionRef,
  parseProvisionRef,
  type Citation,
  type CorpusChunk,
  type DecisionsRegistry,
  type Jurisdiction,
} from '@gc/contracts';
import { resolveDecision, resolveInChunks } from './resolve.js';

// The citation audit (T-03): every citation in the content set, found by walking the
// JSON, resolved against the corpus, its quote confirmed by substring. What it walks
// is every file, not a sample; what it accepts is a real paragraph, not a near one.

export interface FoundCitation {
  readonly file: string;
  readonly path: string;
  readonly citation: Citation;
  readonly jurisdiction: Jurisdiction;
}

export interface CitationProblem {
  readonly file: string;
  readonly path: string;
  readonly key: string;
  readonly reason: string;
  readonly detail: string;
}

export interface CitationAudit {
  readonly files: number;
  readonly citations: number;
  readonly quotes: number;
  readonly problems: readonly CitationProblem[];
}

const CITATION_KINDS = new Set(['provision', 'decision', 'guidance']);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// A citation is an object that says what kind it is, or the phase 0 fixture's pair of
// instrument and display reference. Anything that looks like one and does not parse
// is a problem, not a skip.
export function findCitations(
  value: unknown,
  file: string,
  problems: CitationProblem[],
  path = '$',
  jurisdiction: Jurisdiction = 'EU',
): FoundCitation[] {
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => findCitations(v, file, problems, `${path}[${i}]`, jurisdiction));
  }
  if (!isRecord(value)) return [];
  const here =
    typeof value['jurisdiction'] === 'string' && /^(EU|[A-Z]{2})$/.test(value['jurisdiction'])
      ? (value['jurisdiction'] as Jurisdiction)
      : jurisdiction;
  if (typeof value['kind'] === 'string' && CITATION_KINDS.has(value['kind'])) {
    const parsed = CitationSchema.safeParse(value);
    if (!parsed.success) {
      problems.push({
        file,
        path,
        key: String(value['ref'] ?? value['kind']),
        reason: 'malformed',
        detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
      return [];
    }
    return [{ file, path, citation: parsed.data, jurisdiction: parsed.data.jurisdiction ?? here }];
  }
  if (typeof value['instrument'] === 'string' && typeof value['ref'] === 'string') {
    const extra: { note?: string; jurisdiction?: string } = {};
    if (typeof value['note'] === 'string') extra.note = value['note'];
    if (typeof value['jurisdiction'] === 'string') extra.jurisdiction = value['jurisdiction'];
    const citation =
      parseProvisionRef(value['instrument'], value['ref'], extra) ??
      (/^(case law|decision|judgment)$/i.test(value['instrument'])
        ? parseDecisionRef(value['ref'], extra)
        : undefined);
    if (!citation) {
      problems.push({
        file,
        path,
        key: `${value['instrument']} ${value['ref']}`,
        reason: 'unparseable',
        detail: `"${value['ref']}" is not an article reference the corpus can look up`,
      });
      return [];
    }
    if (typeof value['quote'] === 'string') citation.quote = value['quote'];
    return [{ file, path, citation, jurisdiction: citation.jurisdiction ?? here }];
  }
  return Object.entries(value).flatMap(([k, v]) =>
    findCitations(v, file, problems, `${path}.${k}`, here),
  );
}

export const normaliseQuote = (s: string): string => s.replace(/\s+/g, ' ').trim();

export function auditFound(
  found: readonly FoundCitation[],
  chunks: readonly CorpusChunk[],
  decisions: DecisionsRegistry = { version: '1970-01-01', decisions: [] },
): CitationProblem[] {
  const problems: CitationProblem[] = [];
  for (const f of found) {
    const key = citationKey(f.citation);
    const r =
      f.citation.kind === 'decision'
        ? resolveDecision(decisions, f.citation, f.jurisdiction)
        : resolveInChunks(chunks, f.citation, f.jurisdiction);
    if (!r.ok) {
      problems.push({ file: f.file, path: f.path, key, reason: r.reason, detail: r.detail });
      continue;
    }
    const quote = f.citation.quote;
    const text = 'chunk' in r ? r.chunk.text : r.decision.text;
    if (quote !== undefined && text === undefined) {
      problems.push({
        file: f.file,
        path: f.path,
        key,
        reason: 'quote_unverifiable',
        detail: `${key} is in the corpus without its text, so the quote cannot be confirmed`,
      });
      continue;
    }
    if (
      quote !== undefined &&
      text !== undefined &&
      !normaliseQuote(text).includes(normaliseQuote(quote))
    ) {
      problems.push({
        file: f.file,
        path: f.path,
        key,
        reason: 'quote_not_found',
        detail: `"${quote.slice(0, 60)}${quote.length > 60 ? '…' : ''}" is not in ${key} as published`,
      });
    }
  }
  return problems;
}

export function jsonFilesUnder(dir: string, skip: readonly string[] = []): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      if (skip.some((s) => full.startsWith(s))) continue;
      if (statSync(full).isDirectory()) {
        if (['node_modules', 'dist', '.next'].includes(entry)) continue;
        walk(full);
      } else if (entry.endsWith('.json')) out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

export function auditCitations(
  root: string,
  files: readonly string[],
  chunks: readonly CorpusChunk[],
  decisions?: DecisionsRegistry,
): CitationAudit {
  const problems: CitationProblem[] = [];
  const found: FoundCitation[] = [];
  for (const file of files) {
    const rel = relative(root, file).split(sep).join('/');
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      problems.push({
        file: rel,
        path: '$',
        key: '',
        reason: 'unreadable',
        detail: (e as Error).message,
      });
      continue;
    }
    found.push(...findCitations(json, rel, problems));
  }
  problems.push(...auditFound(found, chunks, decisions));
  return {
    files: files.length,
    citations: found.length,
    quotes: found.filter((f) => f.citation.quote !== undefined).length,
    problems,
  };
}
