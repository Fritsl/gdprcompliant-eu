// pnpm db:seed [--embedder=model]
//
// Loads the shared reference data a database needs before its first scan: the remedy
// catalogue (R-01, without which the finding-needs-a-remedy constraint refuses every
// finding) and the law corpus (A-08, without which no citation resolves and no report
// renders). Idempotent: a remedy already present is left alone, and a corpus version
// already ingested is replaced by the same content. Run after db:migrate, on every
// deployment and on every catalogue or corpus change.
//
// Embeddings come from the deterministic embedder unless --embedder=model is given, in
// which case the configured model endpoint must answer. The deterministic embedder is
// exact for resolution (a lookup, never a search) and only weaker for retrieval.

import { loadConfig } from '@gc/config';
import { ModelClient } from '@gc/agent';
import {
  createModelEmbedder,
  deterministicEmbedder,
  ingestCorpus,
  loadCorpusDocuments,
} from '@gc/corpus';
import { connect, seedRemedies } from '@gc/db';
import { loadCatalogue } from '@gc/remedies';

const useModel = process.argv.includes('--embedder=model');

async function main(): Promise<number> {
  const config = loadConfig();
  const connection = connect(config.database.url);
  try {
    const remedies = await seedRemedies(connection, loadCatalogue());
    console.log(`remedies: ${remedies} inserted`);

    const embed = useModel
      ? createModelEmbedder(new ModelClient(config))
      : deterministicEmbedder();
    // The TEST-* instruments exist for the suites; a real database never holds them.
    const documents = loadCorpusDocuments().filter((d) => !d.instrument.startsWith('TEST-'));
    for (const document of documents) {
      const r = await ingestCorpus(connection, document, embed);
      console.log(`corpus: ${r.instrument} ${r.corpusVersion}, ${r.chunks} chunks`);
    }
    return 0;
  } finally {
    await connection.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error((error as Error).message);
    process.exit(1);
  },
);
