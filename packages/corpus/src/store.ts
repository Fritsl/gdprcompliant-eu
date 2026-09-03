import { and, eq, sql } from 'drizzle-orm';
import {
  CORPUS_EMBEDDING_DIMENSIONS,
  CorpusChunkSchema,
  chunkKey,
  type Citation,
  type CitationResolution,
  type CorpusChunk,
  type CorpusDocument,
  type Jurisdiction,
} from '@gc/contracts';
import { SHARED_TENANT, schema, withTenant, type Connection } from '@gc/db';
import { documentChunks } from './content.js';
import { assertWidth, type Embedder } from './embed.js';
import { newestVersion, resolveInChunks, type ResolveOptions } from './resolve.js';

// The store: corpus_chunks, shared reference data every tenant reads and only the
// ingest writes. Resolution reads the exact key; retrieval orders by embedding distance
// inside the jurisdiction filter, so a chunk from another country's law cannot be
// returned as authority whatever the query says.

const { corpusChunks } = schema;

type Row = typeof corpusChunks.$inferSelect;

function toChunk(row: Row): CorpusChunk {
  return CorpusChunkSchema.parse({
    id: row.id,
    corpusVersion: row.corpusVersion,
    instrument: row.instrument,
    jurisdiction: row.jurisdiction,
    kind: row.kind,
    article: row.article,
    paragraph: row.paragraph ?? undefined,
    point: row.point ?? undefined,
    heading: row.heading ?? undefined,
    text: row.text,
    hash: row.hash,
    source: { url: row.sourceUrl, retrievedAt: new Date(row.retrievedAt).toISOString() },
  });
}

const literal = (vector: number[]): string => `[${vector.join(',')}]`;

// Writes a document's chunks at its version, replacing that version's rows for the
// instrument. Runs as the shared tenant, the only one the policy lets write shared rows.
export async function ingestCorpus(
  connection: Connection,
  document: CorpusDocument,
  embedder: Embedder,
): Promise<{ instrument: string; corpusVersion: string; chunks: number }> {
  const chunks = documentChunks(document);
  const embeddings = await embedder(chunks.map((c) => `${c.heading ?? ''}\n${c.text}`.trim()));
  assertWidth(embeddings, CORPUS_EMBEDDING_DIMENSIONS);
  await withTenant(connection, SHARED_TENANT, async (tx) => {
    await tx
      .delete(corpusChunks)
      .where(
        and(
          eq(corpusChunks.instrument, document.instrument),
          eq(corpusChunks.corpusVersion, document.version),
        ),
      );
    await tx.insert(corpusChunks).values(
      chunks.map((c, i) => ({
        id: c.id,
        tenantId: SHARED_TENANT,
        sourceRef: `corpus:${document.instrument}@${document.version}`,
        corpusVersion: c.corpusVersion,
        instrument: c.instrument,
        jurisdiction: c.jurisdiction,
        kind: c.kind,
        key: chunkKey(c),
        article: c.article,
        paragraph: c.paragraph ?? null,
        point: c.point ?? null,
        heading: c.heading ?? null,
        text: c.text,
        hash: c.hash,
        sourceUrl: c.source.url,
        retrievedAt: new Date(c.source.retrievedAt),
        embedding: embeddings[i]!,
      })),
    );
  });
  return {
    instrument: document.instrument,
    corpusVersion: document.version,
    chunks: chunks.length,
  };
}

export async function corpusVersions(
  connection: Connection,
): Promise<{ instrument: string; corpusVersion: string; chunks: number }[]> {
  const rows = await connection.db
    .select({
      instrument: corpusChunks.instrument,
      corpusVersion: corpusChunks.corpusVersion,
      chunks: sql<number>`count(*)::int`,
    })
    .from(corpusChunks)
    .groupBy(corpusChunks.instrument, corpusChunks.corpusVersion)
    .orderBy(corpusChunks.instrument, corpusChunks.corpusVersion);
  return rows;
}

// Exactly one chunk or a typed failure; see resolve.ts for the rules.
export async function resolveCitation(
  connection: Connection,
  citation: Citation,
  jurisdiction: Jurisdiction,
  options: ResolveOptions = {},
): Promise<CitationResolution> {
  if (citation.kind !== 'provision') return resolveInChunks([], citation, jurisdiction, options);
  const rows = await connection.db
    .select()
    .from(corpusChunks)
    .where(eq(corpusChunks.instrument, citation.instrument));
  return resolveInChunks(rows.map(toChunk), citation, jurisdiction, options);
}

export interface RetrieveOptions {
  readonly jurisdiction: Jurisdiction;
  readonly k?: number;
  // Pin a corpus version; otherwise each instrument answers from its newest.
  readonly corpusVersion?: string;
}

export interface Retrieved {
  readonly chunk: CorpusChunk;
  // Cosine distance; smaller is nearer.
  readonly distance: number;
}

// Nearest chunks to the query, from Union law and the case's own jurisdiction only.
export async function retrieve(
  connection: Connection,
  query: string,
  embedder: Embedder,
  options: RetrieveOptions,
): Promise<Retrieved[]> {
  const k = options.k ?? 8;
  const [vector] = await embedder([query]);
  if (!vector) return [];
  assertWidth([vector], CORPUS_EMBEDDING_DIMENSIONS);
  const versions = await corpusVersions(connection);
  const newest = new Map<string, string>();
  for (const v of versions) {
    const wanted =
      options.corpusVersion ??
      newestVersion(
        versions.filter((x) => x.instrument === v.instrument).map((x) => x.corpusVersion),
      );
    if (wanted !== undefined) newest.set(v.instrument, wanted);
  }
  if (newest.size === 0) return [];
  const versionFilter = sql.join(
    [...newest].map(
      ([instrument, version]) =>
        sql`(${corpusChunks.instrument} = ${instrument} and ${corpusChunks.corpusVersion} = ${version})`,
    ),
    sql` or `,
  );
  const distance = sql<number>`${corpusChunks.embedding} <=> ${literal(vector)}::vector`;
  const rows = await connection.db
    .select({ row: corpusChunks, distance })
    .from(corpusChunks)
    .where(
      and(
        sql`${corpusChunks.jurisdiction} in ('EU', ${options.jurisdiction})`,
        sql`${corpusChunks.embedding} is not null`,
        sql`(${versionFilter})`,
      ),
    )
    .orderBy(distance, corpusChunks.key)
    .limit(k);
  return rows.map((r) => ({ chunk: toChunk(r.row), distance: Number(r.distance) }));
}
