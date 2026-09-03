// @gc/corpus — the legal corpus: curated instruments cut into addressable chunks, a
// resolver that meets a citation exactly or not at all, an embedder for retrieval, and
// the store that holds both (A-08).
//
//   content   the instrument files under content/, validated
//   resolve   citation → exactly one chunk, or a typed failure; jurisdiction-aware
//   embed     embeddings from the model endpoint, and a deterministic one for tests
//   store     ingest into corpus_chunks; resolve and retrieve from the database

export const PACKAGE = '@gc/corpus';

export * from './content.js';
export * from './resolve.js';
export * from './embed.js';
export * from './store.js';
