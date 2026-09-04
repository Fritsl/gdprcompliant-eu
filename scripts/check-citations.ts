// pnpm check:citations (T-03)
//
// Every citation in the content set — the remedy catalogue, the finding content, the
// fixtures, the web copy, the artefact templates — resolves to a real paragraph of the
// corpus as published, and any quote it carries is found there character for
// character. The whole set, every run; one miss fails the build.

import { join } from 'node:path';
import {
  auditCitations,
  documentChunks,
  jsonFilesUnder,
  loadCorpusDocuments,
  loadDecisions,
} from '@gc/corpus';

const root = process.cwd();
const corpus = loadCorpusDocuments();
const chunks = corpus.flatMap(documentChunks);
const decisions = loadDecisions();

const files = [
  join(root, 'packages', 'remedies', 'content'),
  join(root, 'packages', 'findings', 'content'),
  join(root, 'packages', 'artefacts', 'content'),
  join(root, 'packages', 'rules', 'content'),
  join(root, 'packages', 'i18n', 'content'),
  join(root, 'apps', 'web', 'content'),
  join(root, 'fixtures', 'companies'),
  join(root, 'fixtures', 'policies'),
].flatMap((dir) => jsonFilesUnder(dir));

// Consolidated text is dated (V-03): an instrument that does not say what date its
// text speaks from cannot be quoted, so it cannot be in the corpus.
const undated = corpus.filter((d) => !d.source.textAsOf);
for (const d of undated) console.error(`  ✗ ${d.instrument}@${d.version}: no source.textAsOf`);
if (undated.length > 0) {
  console.error(`citations: ${undated.length} undated instrument(s)`);
  process.exit(1);
}

const audit = auditCitations(root, files, chunks, decisions);
console.log(
  `citations — ${corpus.map((d) => `${d.instrument}@${d.version} (${d.chunks.length})`).join(', ')}; ${decisions.decisions.length} decisions; ${audit.files} content files, ${audit.citations} citations, ${audit.quotes} quotes`,
);
for (const p of audit.problems) {
  console.error(`  ✗ ${p.file} ${p.path} ${p.key}: ${p.reason} — ${p.detail}`);
}
if (audit.problems.length > 0) {
  console.error(`citations: ${audit.problems.length} problem(s)`);
  process.exit(1);
}
console.log('citations: every one resolves; every quote is as published');
