// pnpm corpus:ingest [instrument...] (A-08, T-03)
//
// Fetches each Union instrument in packages/corpus/content/sources.json from the
// Publications Office cellar through the recorded fetch, cuts it into chunks, and
// writes packages/corpus/content/<instrument>.json. In replay mode (the default) the
// cassette answers, so the content file is reproducible from what was recorded; with
// GC_NETWORK=record the live text is fetched and the cassette rewritten.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRecordedFetch, loadConfig } from '@gc/config';
import { CONTENT_DIR, documentFromCellar, fetchCellar, type CorpusSource } from '@gc/corpus';

const wanted = new Set(process.argv.slice(2));
const sources = JSON.parse(readFileSync(join(CONTENT_DIR, 'sources.json'), 'utf8')) as CorpusSource[];
const config = loadConfig({
  ...process.env,
  DATABASE_URL: process.env['DATABASE_URL'] ?? 'postgres://unused',
  MODEL_BASE_URL: process.env['MODEL_BASE_URL'] ?? 'http://localhost:8000/v1',
  MODEL_CHAT: process.env['MODEL_CHAT'] ?? 'unused',
  MODEL_EMBEDDING: process.env['MODEL_EMBEDDING'] ?? 'unused',
  APP_BASE_URL: process.env['APP_BASE_URL'] ?? 'https://gdprcompliant.eu',
});
const outbound = createRecordedFetch(config, { name: 'corpus-cellar' });
const today = new Date().toISOString().slice(0, 10);

for (const source of sources) {
  if (wanted.size > 0 && !wanted.has(source.instrument)) continue;
  const html = await fetchCellar(outbound, source.celex);
  const file = join(CONTENT_DIR, `${source.instrument}.json`);
  let version = today;
  let retrievedAt = new Date().toISOString();
  try {
    // Replaying keeps the stamp the recording had, so the file is byte-stable.
    const existing = JSON.parse(readFileSync(file, 'utf8')) as { version: string; source: { retrievedAt: string } };
    if (config.network.mode === 'replay') {
      version = existing.version;
      retrievedAt = existing.source.retrievedAt;
    }
  } catch {
    // First ingest.
  }
  const document = documentFromCellar(source, html, { version, retrievedAt });
  writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);
  console.log(`${source.instrument}: ${document.chunks.length} chunks at ${version} → ${file}`);
}
