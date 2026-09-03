import { describe, expect, it, vi } from 'vitest';
import {
  CORPUS_EMBEDDING_DIMENSIONS,
  CorpusChunkSchema,
  CorpusDocumentSchema,
  chunkKey,
  parseProvisionRef,
} from '@gc/contracts';
import { ModelClient } from '@gc/agent';
import { loadConfig } from '@gc/config';
import {
  createModelEmbedder,
  deterministicEmbedder,
  documentChunks,
  loadCorpusDocuments,
  resolveInChunks,
} from '@gc/corpus';

// The corpus without a database (A-08): the content files validate, every chunk carries
// its identifiers, resolution is exact, the jurisdiction filter is part of resolution,
// and the embedder speaks to the model endpoint through the recorded fetch.

const docs = loadCorpusDocuments();
const chunks = docs.flatMap(documentChunks);
const cite = (instrument: string, ref: string) => parseProvisionRef(instrument, ref);

describe('content', () => {
  it('every checked-in instrument validates and every chunk carries its identifiers', () => {
    expect(docs.map((d) => d.instrument)).toEqual(['GDPR', 'TEST-DK', 'TEST-REG', 'ePrivacy']);
    for (const c of chunks) {
      expect(CorpusChunkSchema.safeParse(c).success).toBe(true);
      expect(c.jurisdiction).toMatch(/^(EU|[A-Z]{2})$/);
      expect(c.instrument).toBeTruthy();
      expect(c.article).toMatch(/^\d+[a-z]?$/);
      expect(c.corpusVersion).toMatch(/^\d{4}-\d{2}-\d{2}/);
      expect(c.id).toBe(`${chunkKey(c)}@${c.corpusVersion}`);
    }
    expect(new Set(chunks.map((c) => c.id)).size).toBe(chunks.length);
  });

  it('a file with the same paragraph twice does not load', () => {
    const doc = docs.find((d) => d.instrument === 'TEST-REG')!;
    const twice = { ...doc, chunks: [...doc.chunks, doc.chunks[1]!] };
    const r = CorpusDocumentSchema.safeParse(twice);
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/duplicate chunk TEST-REG:5:1/);
  });
});

describe('resolution is a lookup, not a search', () => {
  it('resolves a paragraph and a point exactly, and carries the corpus version', () => {
    const p = resolveInChunks(chunks, cite('TEST-REG', 'Art. 5(3)'), 'DK');
    expect(p.ok && p.chunk.id).toBe('TEST-REG:5:3@2026-09-04.test');
    expect(p.ok && p.corpusVersion).toBe('2026-09-04.test');
    const point = resolveInChunks(chunks, cite('TEST-REG', 'Art. 5(1)(a)'), 'DE');
    expect(point.ok && point.chunk.heading).toBe('Lawfulness, fairness and transparency');
  });

  it('a paragraph that does not exist fails; the neighbour is never offered', () => {
    for (const ref of ['Art. 5(4)', 'Art. 5', 'Art. 5(3)(a)', 'Art. 99', 'Art. 5(1)(b)']) {
      const r = resolveInChunks(chunks, cite('TEST-REG', ref), 'DK');
      expect(r.ok, ref).toBe(false);
      expect(!r.ok && r.reason, ref).toBe('no_such_paragraph');
    }
  });

  it('an instrument that is not in the corpus fails as such', () => {
    const r = resolveInChunks(chunks, cite('NOPE', 'Art. 1'), 'DK');
    expect(!r.ok && r.reason).toBe('unknown_instrument');
  });

  it('Union law resolves everywhere; a national act only at home', () => {
    expect(resolveInChunks(chunks, cite('TEST-REG', 'Art. 7(3)'), 'DE').ok).toBe(true);
    expect(resolveInChunks(chunks, cite('TEST-DK', 'Art. 3(1)'), 'DK').ok).toBe(true);
    const abroad = resolveInChunks(chunks, cite('TEST-DK', 'Art. 3(1)'), 'DE');
    expect(!abroad.ok && abroad.reason).toBe('wrong_jurisdiction');
    expect(!abroad.ok && abroad.detail).toBe('TEST-DK speaks in DK, not DE');
  });

  it('a pinned version that the corpus does not hold fails rather than answering from another', () => {
    const r = resolveInChunks(chunks, cite('TEST-REG', 'Art. 5(3)'), 'DK', {
      corpusVersion: '2020-01-01',
    });
    expect(!r.ok && r.reason).toBe('unknown_instrument');
  });

  it('decision and guidance citations do not resolve to a paragraph yet', () => {
    const r = resolveInChunks(
      chunks,
      { kind: 'decision', body: 'Datatilsynet', reference: '2020-31-1234' },
      'DK',
    );
    expect(!r.ok && r.reason).toBe('unsupported_kind');
  });
});

describe('embedders', () => {
  it('the deterministic embedder is stable, unit length, and nearer for shared words', async () => {
    const embed = deterministicEmbedder();
    const [a, b, c] = await embed([
      'consent before storing information in terminal equipment',
      'storing information in terminal equipment needs consent',
      'the supervisory authority handles complaints',
    ]);
    expect(a).toHaveLength(CORPUS_EMBEDDING_DIMENSIONS);
    expect((await embed(['consent before storing information in terminal equipment']))[0]).toEqual(
      a,
    );
    const dot = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i]!, 0);
    expect(dot(a!, a!)).toBeCloseTo(1, 6);
    expect(dot(a!, b!)).toBeGreaterThan(dot(a!, c!));
  });

  it('the model embedder is the model client, with the width checked on the way out', async () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://gc:gc@localhost:5432/gdprcompliant',
      MODEL_BASE_URL: 'http://localhost:8000/v1',
      MODEL_API_KEY: 'secret-key',
      MODEL_CHAT: 'chat-model',
      MODEL_EMBEDDING: 'embedding-model',
      APP_BASE_URL: 'https://gdprcompliant.eu',
      GC_NETWORK: 'live',
    });
    const seen: { url: string; body: string }[] = [];
    const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const body = String(init?.body);
      seen.push({ url: String(url), body });
      const n = (JSON.parse(body) as { input: string[] }).input.length;
      const vec = new Array(CORPUS_EMBEDDING_DIMENSIONS).fill(0.5);
      return new Response(
        JSON.stringify({
          data: Array.from({ length: n }, (_, i) => ({
            index: n - 1 - i,
            embedding: vec.map((x) => x + (n - 1 - i)),
          })),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const embed = createModelEmbedder(new ModelClient(config, { fetch: impl }));
    const vectors = await embed(['one', 'two']);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toContain('localhost:8000/v1/');
    expect((JSON.parse(seen[0]!.body) as { input: string[] }).input).toEqual(['one', 'two']);
    // Answers come back in index order whatever order the endpoint sent them.
    expect(vectors[0]![0]).toBe(0.5);
    expect(vectors[1]![0]).toBe(1.5);

    const narrow = createModelEmbedder({ embed: async () => [[1, 2, 3]] });
    await expect(narrow(['x'])).rejects.toThrow(
      /returned 3 dimensions; the corpus is declared with 1024/,
    );
  });
});
