import type { OutboundFetch } from '@gc/config';
import {
  CorpusDocumentSchema,
  type CorpusChunkKind,
  type CorpusDocument,
  type Jurisdiction,
} from '@gc/contracts';

// Union instruments come from the Publications Office cellar, the store behind EUR-Lex,
// as the XHTML of the Official Journal text (an ELI-structured document: one
// eli-subdivision per article). The text is taken as published and cut into
// article, paragraph and point chunks; nothing is typed in, so a quote in a remedy is
// checked against the words the Journal printed.

export const CELLAR_HOST = 'publications.europa.eu';

export const cellarUrl = (celex: string): string =>
  `https://${CELLAR_HOST}/resource/celex/${encodeURIComponent(celex)}`;

export interface CorpusSource {
  readonly instrument: string;
  readonly title: string;
  readonly jurisdiction: Jurisdiction;
  readonly celex: string;
  // The date the consolidated text speaks from, as the Publications Office dates it.
  readonly textAsOf: string;
}

// The cellar answers a CELEX id with a 303 to the document; the Location it gives is
// plain http, so the second hop is made over https by hand rather than followed blind.
export async function fetchCellar(outbound: OutboundFetch, celex: string): Promise<string> {
  const headers = { accept: 'application/xhtml+xml', 'accept-language': 'eng' };
  const first = await outbound(cellarUrl(celex), {
    purpose: 'corpus',
    headers,
    redirect: 'manual',
  });
  let response = first;
  if (first.status >= 300 && first.status < 400) {
    const location = first.headers.get('location');
    if (!location) throw new Error(`cellar redirected ${celex} without a location`);
    const next = new URL(location);
    next.protocol = 'https:';
    if (next.host !== CELLAR_HOST)
      throw new Error(`cellar redirected ${celex} off-host: ${next.host}`);
    response = await outbound(next, { purpose: 'corpus', headers });
  }
  if (!response.ok) throw new Error(`cellar answered ${response.status} for ${celex}`);
  return response.text();
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === '#') {
      const n =
        code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

// Consolidated texts mark amendments inline (►M2 … ◄) and with ▼M2 lines; the marks are
// editorial, not law, and go.
const AMENDMENT_MARKS = /[►▼◄][A-Z]?\d*/g;

// One line per block element, whitespace collapsed, empties dropped.
export function blockLines(html: string): string[] {
  const withBreaks = html
    .replace(/<(?:p|div|td|tr|table|br|li|h\d)\b[^>]*>/gi, '\n')
    .replace(/<\/(?:p|div|td|tr|table|li|h\d)>/gi, '\n')
    .replace(/<span class="no-parag">/g, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(withBreaks)
    .replace(AMENDMENT_MARKS, ' ')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 0);
}

export interface ParsedChunk {
  readonly kind: CorpusChunkKind;
  readonly article: string;
  readonly paragraph?: string;
  readonly point?: string;
  readonly heading?: string;
  readonly text: string;
}

interface Unit {
  label: string;
  lines: string[];
  points: { label: string; lines: string[] }[];
}

const ARTICLE_START = /<div class="eli-subdivision" id="art_(\d+[a-z]?)"[^>]*>/g;
const BLOCK_END = /<div class="(?:eli-subdivision|oj-final|final|signatory)"/;
const PARAGRAPH = /^(\d+)\.(?:\s+(.*))?$/;
const POINT = /^\(([a-z]+|\d+)\)(?:\s+(.*))?$/;

// Cuts one article's block into its paragraphs and points. Numbered paragraphs ("1.")
// hold points ("(a)"); an article whose items are numbered in brackets, like the
// definitions, reads those as paragraphs, which is how they are cited ("Art. 4(11)").
export function parseArticle(
  article: string,
  heading: string | undefined,
  lines: string[],
): ParsedChunk[] {
  const preamble: string[] = [];
  const paragraphs: Unit[] = [];
  let pending: { kind: 'paragraph' | 'point'; label: string } | undefined;
  const current = () => paragraphs.at(-1);

  for (const line of lines) {
    const p = PARAGRAPH.exec(line);
    const pt = p ? undefined : POINT.exec(line);
    if (p) {
      paragraphs.push({ label: p[1]!, lines: p[2] ? [p[2]] : [], points: [] });
      pending = p[2] ? undefined : { kind: 'paragraph', label: p[1]! };
      continue;
    }
    if (pt) {
      const label = pt[1]!;
      if (/^\d+$/.test(label)) {
        paragraphs.push({ label, lines: pt[2] ? [pt[2]] : [], points: [] });
        pending = pt[2] ? undefined : { kind: 'paragraph', label };
        continue;
      }
      const owner =
        current() ?? paragraphs[paragraphs.push({ label: '', lines: [], points: [] }) - 1]!;
      owner.points.push({ label, lines: pt[2] ? [pt[2]] : [] });
      pending = pt[2] ? undefined : { kind: 'point', label };
      continue;
    }
    const unit = current();
    if (!unit) preamble.push(line);
    else if (unit.points.length > 0 && (pending?.kind === 'point' || pending === undefined)) {
      unit.points.at(-1)!.lines.push(line);
    } else unit.lines.push(line);
    pending = undefined;
  }

  const paragraphText = (u: Unit) =>
    [...u.lines, ...u.points.flatMap((pt) => [`(${pt.label}) ${pt.lines.join(' ')}`])].join('\n');
  const out: ParsedChunk[] = [];
  const whole = [
    ...preamble,
    ...paragraphs.map((u) => (u.label ? `${u.label}. ` : '') + paragraphText(u)),
  ]
    .join('\n')
    .trim();
  if (whole.length === 0) return out;
  out.push({ kind: 'article', article, ...(heading ? { heading } : {}), text: whole });
  for (const u of paragraphs) {
    if (u.label) {
      out.push({
        kind: 'article',
        article,
        paragraph: u.label,
        ...(heading ? { heading } : {}),
        text: paragraphText(u),
      });
    }
    for (const pt of u.points) {
      const text = pt.lines.join(' ');
      if (text.length === 0) continue;
      out.push({
        kind: 'article',
        article,
        ...(u.label ? { paragraph: u.label } : {}),
        point: pt.label,
        ...(heading ? { heading } : {}),
        text,
      });
    }
  }
  return out;
}

export function parseArticles(html: string): ParsedChunk[] {
  const starts = [...html.matchAll(ARTICLE_START)];
  const out: ParsedChunk[] = [];
  starts.forEach((m, i) => {
    const from = m.index! + m[0].length;
    const rest = html.slice(from, starts[i + 1]?.index ?? html.length);
    const end = BLOCK_END.exec(rest);
    const block = end ? rest.slice(0, end.index) : rest;
    const title = /<div class="eli-title"[^>]*>([\s\S]*?)<\/div>/.exec(block);
    const heading = title ? blockLines(title[1]!).join(' ') : undefined;
    const body = title ? block.replace(title[0], '') : block;
    const lines = blockLines(body).filter((l) => !/^Article \d+[a-z]?$/.test(l));
    out.push(...parseArticle(m[1]!, heading, lines));
  });
  return out;
}

export function documentFromCellar(
  source: CorpusSource,
  html: string,
  stamp: { version: string; retrievedAt: string },
): CorpusDocument {
  const chunks = parseArticles(html);
  if (chunks.length === 0)
    throw new Error(`${source.celex}: no articles found in the cellar document`);
  return CorpusDocumentSchema.parse({
    instrument: source.instrument,
    title: source.title,
    jurisdiction: source.jurisdiction,
    version: stamp.version,
    source: {
      url: cellarUrl(source.celex),
      retrievedAt: stamp.retrievedAt,
      textAsOf: source.textAsOf,
    },
    chunks,
  });
}
