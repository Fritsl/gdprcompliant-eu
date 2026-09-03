import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CorpusDocumentSchema,
  DecisionsRegistrySchema,
  type DecisionsRegistry,
  chunkKey,
  sha256,
  type CorpusChunk,
  type CorpusDocument,
} from '@gc/contracts';

// The curated content: one JSON file per instrument under content/. Loading validates
// every file, so a malformed instrument fails here, never at resolution time.

export const CONTENT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'content');

export function loadCorpusDocument(file: string): CorpusDocument {
  const parsed = CorpusDocumentSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`${file}: ${issues.join('; ')}`);
  }
  return parsed.data;
}

export function loadCorpusDocuments(dir: string = CONTENT_DIR): CorpusDocument[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !['sources.json', 'decisions.json'].includes(f))
    .sort()
    .map((f) => loadCorpusDocument(join(dir, f)));
}

export function loadDecisions(dir: string = CONTENT_DIR): DecisionsRegistry {
  const file = join(dir, 'decisions.json');
  const parsed = DecisionsRegistrySchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`${file}: ${issues.join('; ')}`);
  }
  return parsed.data;
}

// The chunk id is the key at a version, so the same paragraph at two corpus versions
// is two rows, and a claim's corpus version names exactly which one it read.
export const chunkId = (key: string, version: string): string => `${key}@${version}`;

export function documentChunks(doc: CorpusDocument): CorpusChunk[] {
  return doc.chunks.map((c) => {
    const key = chunkKey({ instrument: doc.instrument, ...c });
    const chunk: CorpusChunk = {
      id: chunkId(key, doc.version),
      corpusVersion: doc.version,
      instrument: doc.instrument,
      jurisdiction: doc.jurisdiction,
      kind: c.kind,
      article: c.article,
      text: c.text,
      hash: sha256(`${key}\n${c.text}`),
      source: doc.source,
    };
    if (c.paragraph !== undefined) chunk.paragraph = c.paragraph;
    if (c.point !== undefined) chunk.point = c.point;
    if (c.heading !== undefined) chunk.heading = c.heading;
    return chunk;
  });
}
