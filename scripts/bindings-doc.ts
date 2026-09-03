// pnpm bindings:doc (I-02)
//
// Renders docs/bindings.md from packages/findings/content/bindings/*.json: one table per
// jurisdiction, a row per finding type, the provisions as a lawyer would read them. The
// document is generated, never hand-drawn; a unit test fails when it is stale.
//
//   pnpm bindings:doc           write docs/bindings.md
//   pnpm bindings:doc --check   exit 1 if docs/bindings.md is out of date

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { citationKey, type BindingTable, type Jurisdiction } from '@gc/contracts';
import { DETECTORS, citationFromRow, loadBindingTables } from '@gc/findings';

export const TARGET = fileURLToPath(new URL('../docs/bindings.md', import.meta.url));

const area = new Map(DETECTORS.map((d) => [d.findingTypeId, d.area]));

export function renderBindings(tables: Map<Jurisdiction, BindingTable>): string {
  const lines: string[] = [];
  lines.push('# Jurisdiction bindings');
  lines.push('');
  lines.push(
    'Generated from `packages/findings/content/bindings/*.json` by `scripts/bindings-doc.ts`. A finding',
  );
  lines.push(
    'type is the same finding everywhere; what it rests on, who would hear a complaint and which',
  );
  lines.push(
    'guide explains it are bound per jurisdiction, here. Every citation resolves in the corpus',
  );
  lines.push('(`pnpm check:citations`); every type the product can raise is bound in every supported');
  lines.push('jurisdiction (`pnpm check:finding-completeness`). Detector code names no article.');
  lines.push('');
  for (const [jurisdiction, table] of [...tables.entries()].sort()) {
    lines.push(`## ${jurisdiction}`);
    lines.push('');
    lines.push(`Table version ${table.version}. Authority: ${table.authority.name}${table.authority.url ? ` (${table.authority.url})` : ''}.`);
    lines.push(
      table.reviewed
        ? `Last reviewed by ${table.reviewed.by} on ${table.reviewed.at}.`
        : 'Not yet reviewed by a lawyer.',
    );
    lines.push('');
    lines.push('| Finding | Area | Rests on | Guide |');
    lines.push('| --- | --- | --- | --- |');
    for (const b of table.bindings) {
      const cites = b.citations
        .map((c) => {
          const typed = citationFromRow(c);
          const key = citationKey(typed);
          return `${c.instrument} ${c.ref}${c.note ? ` — ${c.note}` : ''} \`${key}\``;
        })
        .join('<br>');
      lines.push(`| ${b.findingTypeId} | ${area.get(b.findingTypeId) ?? ''} | ${cites} | ${b.guideId} v${b.version ?? table.version} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const rendered = renderBindings(loadBindingTables());
  if (process.argv.includes('--check')) {
    const current = readFileSync(TARGET, 'utf8');
    if (current !== rendered) {
      console.error('docs/bindings.md is out of date: run pnpm bindings:doc');
      process.exit(1);
    }
    console.log('docs/bindings.md is current');
  } else {
    writeFileSync(TARGET, rendered);
    console.log(`${TARGET}: ${rendered.length} bytes written`);
  }
}
