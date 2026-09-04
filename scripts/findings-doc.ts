// pnpm findings:doc (S-15)
//
// Renders docs/findings.md from the registry: every finding type the product can raise,
// with its area, default severity, detector and family, its remedy in each jurisdiction,
// its bindings, its guide, and the fixtures that prove it fires and does not. Generated,
// never hand-drawn; a unit test fails when it is stale.
//
//   pnpm findings:doc           write docs/findings.md
//   pnpm findings:doc --check   exit 1 if docs/findings.md is out of date

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { citationKey, type Jurisdiction } from '@gc/contracts';
import { DETECTORS, checkFamilyFor, citationFromRow, loadBindingTables } from '@gc/findings';
import { loadCatalogue, loadGuides } from '@gc/remedies';
import { loadFixtureSites } from '@gc/scanner';

export const TARGET = fileURLToPath(new URL('../docs/findings.md', import.meta.url));

export function renderFindingsDoc(): string {
  const tables = loadBindingTables();
  const catalogue = loadCatalogue();
  const guides = loadGuides();
  const sites = loadFixtureSites();
  const jurisdictions = [...tables.keys()].sort() as Jurisdiction[];
  const lines: string[] = [];
  lines.push('# The finding types');
  lines.push('');
  lines.push(
    'Generated from the registry by `scripts/findings-doc.ts`: `packages/findings/content/detectors.json`,',
  );
  lines.push(
    'the binding tables, the remedy catalogue, the guides and the fixture estate. Every type the product',
  );
  lines.push(
    'can raise has a detector, a remedy of a declared kind in every supported jurisdiction, a binding',
  );
  lines.push(
    'that resolves in the corpus, a guide a non-specialist can follow, and a fixture that proves it',
  );
  lines.push('fires and one that proves it does not. A type missing any of these fails the build.');
  lines.push('');
  lines.push(`${DETECTORS.length} types. Jurisdictions: ${jurisdictions.join(', ')}.`);
  lines.push('');
  const sorted = [...DETECTORS].sort((a, b) => a.findingTypeId.localeCompare(b.findingTypeId));
  for (const d of sorted) {
    const id = d.findingTypeId;
    const guide = guides.forFinding(id);
    lines.push(`## ${id} · ${guide ? (guide.title.en ?? id) : id}`);
    lines.push('');
    lines.push(`- Area: ${d.area}. Default severity: ${d.defaultSeverity}.`);
    lines.push(
      `- Detector: \`${d.detector}\`${checkFamilyFor(id) ? ` (family \`${checkFamilyFor(id)}\`)` : ' (no scanner family: verified another way)'}.`,
    );
    for (const j of jurisdictions) {
      const remedies = catalogue.forFinding(id, j);
      lines.push(
        `- Remedy in ${j}: ${remedies.length > 0 ? remedies.map((r) => `\`${r.remedy.id}\` v${r.remedy.version} (${r.remedy.kind}, verified by ${r.remedy.verification.method})`).join(', ') : '**none**'}.`,
      );
      const binding = tables.get(j)?.bindings.find((b) => b.findingTypeId === id);
      lines.push(
        `- Rests on in ${j}: ${
          binding
            ? binding.citations
                .map((c) => `${c.instrument} ${c.ref} \`${citationKey(citationFromRow(c))}\``)
                .join('; ')
            : '**unbound**'
        }.`,
      );
    }
    lines.push(`- Guide: ${guide ? `\`${guide.id}\` (${Object.keys(guide.title).sort().join(', ')})` : '**none**'}.`);
    const positive = sites.filter((s) => s.expected.findings.must.includes(id)).map((s) => s.name);
    const negative = sites.filter((s) => s.expected.findings.mustNot.includes(id)).map((s) => s.name);
    lines.push(`- Fixtures that must raise it: ${positive.length > 0 ? positive.join(', ') : '**none**'}.`);
    lines.push(`- Fixtures that must not: ${negative.length > 0 ? negative.join(', ') : '**none**'}.`);
    lines.push('');
  }
  return lines.join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const rendered = renderFindingsDoc();
  if (process.argv.includes('--check')) {
    const current = readFileSync(TARGET, 'utf8');
    if (current !== rendered) {
      console.error('docs/findings.md is out of date: run pnpm findings:doc');
      process.exit(1);
    }
    console.log('docs/findings.md is current');
  } else {
    writeFileSync(TARGET, rendered);
    console.log(`${TARGET}: ${rendered.length} bytes written`);
  }
}
