import { createHash } from 'node:crypto';
import type { ModelClient } from '@gc/agent';
import { CORPUS_EMBEDDING_DIMENSIONS } from '@gc/contracts';

// An embedder turns texts into vectors of the width the corpus table is declared with.
// The real one is the model client's embed call (T-04: the only code that reaches the
// endpoint) with the width checked on the way out. The deterministic one exists for
// tests and needs no network: the same text always gives the same vector, and texts
// that share words land near each other.

export type Embedder = (texts: readonly string[]) => Promise<number[][]>;

export class EmbeddingWidthError extends Error {
  constructor(
    public readonly expected: number,
    public readonly actual: number,
  ) {
    super(
      `the embedding model returned ${actual} dimensions; the corpus is declared with ${expected}`,
    );
    this.name = 'EmbeddingWidthError';
  }
}

export function assertWidth(vectors: number[][], dimensions = CORPUS_EMBEDDING_DIMENSIONS): void {
  for (const v of vectors) {
    if (v.length !== dimensions) throw new EmbeddingWidthError(dimensions, v.length);
  }
}

export function createModelEmbedder(
  client: Pick<ModelClient, 'embed'>,
  dimensions = CORPUS_EMBEDDING_DIMENSIONS,
): Embedder {
  return async (texts) => {
    if (texts.length === 0) return [];
    const vectors = await client.embed(texts);
    assertWidth(vectors, dimensions);
    return vectors;
  };
}

export const tokens = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 2);

// Hashed bag of words on the unit sphere. Not a model; a stand-in with the one property
// retrieval tests need, that shared vocabulary means a shorter distance.
export function deterministicEmbedder(dimensions = CORPUS_EMBEDDING_DIMENSIONS): Embedder {
  return async (texts) =>
    texts.map((text) => {
      const v = new Array<number>(dimensions).fill(0);
      for (const token of tokens(text)) {
        const digest = createHash('sha256').update(token).digest();
        const index = digest.readUInt32BE(0) % dimensions;
        const sign = digest[4]! & 1 ? 1 : -1;
        v[index] = v[index]! + sign;
      }
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
      return v.map((x) => x / norm);
    });
}
