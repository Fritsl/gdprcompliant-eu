#!/usr/bin/env node
// Generate docs/schema.md from the latest Drizzle snapshot (F-03). Never hand-drawn.
//
//   node scripts/schema-doc.mjs           write docs/schema.md
//   node scripts/schema-doc.mjs --check   exit 1 if docs/schema.md is out of date

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const META_DIR = fileURLToPath(new URL('../packages/db/migrations/meta/', import.meta.url));
export const TARGET = fileURLToPath(new URL('../docs/schema.md', import.meta.url));

export function latestSnapshot(dir = META_DIR) {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('_snapshot.json'))
    .sort();
  const file = files[files.length - 1];
  if (!file) throw new Error(`no snapshot in ${dir}`);
  return { file, snapshot: JSON.parse(readFileSync(join(dir, file), 'utf8')) };
}

const bare = (name) => name.replace(/^public\./, '');

export function render({ file, snapshot }) {
  const tables = Object.values(snapshot.tables).sort((a, b) => a.name.localeCompare(b.name));
  const lines = [];
  lines.push('# Schema');
  lines.push('');
  lines.push(`Generated from \`packages/db/migrations/meta/${file}\` by \`scripts/schema-doc.mjs\`.`);
  lines.push('Do not edit; change `packages/db/src/schema.ts`, run `pnpm db:generate`, then `pnpm db:doc`.');
  lines.push('');
  lines.push('Every table carries `tenant_id`, `created_at` and `source_ref`. `case_events` and');
  lines.push('`evidence` refuse UPDATE and DELETE; `findings.remedy_id` is NOT NULL.');
  lines.push('');
  lines.push('```mermaid');
  lines.push('erDiagram');
  for (const t of tables) {
    lines.push(`  ${t.name} {`);
    for (const c of Object.values(t.columns)) {
      const flags = [c.primaryKey ? 'PK' : '', c.notNull ? '' : 'nullable'].filter(Boolean).join(' ');
      lines.push(`    ${c.type.replace(/\s.*$/, '').replace(/[^a-z_]/g, '_')} ${c.name}${flags ? ` "${flags}"` : ''}`);
    }
    lines.push('  }');
  }
  for (const t of tables) {
    for (const fk of Object.values(t.foreignKeys ?? {})) {
      lines.push(`  ${bare(fk.tableTo)} ||--o{ ${t.name} : "${fk.columnsFrom.join(', ')}"`);
    }
  }
  lines.push('```');
  lines.push('');
  for (const t of tables) {
    lines.push(`## ${t.name}`);
    lines.push('');
    lines.push('| Column | Type | Constraints |');
    lines.push('| --- | --- | --- |');
    for (const c of Object.values(t.columns)) {
      const parts = [];
      if (c.primaryKey) parts.push('primary key');
      if (c.notNull) parts.push('not null');
      if (c.default !== undefined) parts.push(`default ${String(c.default).replace(/\|/g, '\\|')}`);
      lines.push(`| ${c.name} | ${c.type} | ${parts.join(', ')} |`);
    }
    const checks = Object.values(t.checkConstraints ?? {});
    const fks = Object.values(t.foreignKeys ?? {});
    const idx = Object.values(t.indexes ?? {});
    const pk = Object.values(t.compositePrimaryKeys ?? {});
    if (pk.length + checks.length + fks.length + idx.length > 0) {
      lines.push('');
      for (const p of pk) lines.push(`- primary key (${p.columns.join(', ')})`);
      for (const f of fks) lines.push(`- ${f.columnsFrom.join(', ')} → ${bare(f.tableTo)}(${f.columnsTo.join(', ')})`);
      for (const i of idx) lines.push(`- ${i.isUnique ? 'unique ' : ''}index ${i.name} (${i.columns.map((c) => c.expression).join(', ')})`);
      for (const c of checks) lines.push(`- check ${c.name}: \`${c.value.replace(/\s+/g, ' ')}\``);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

const main = () => {
  const doc = render(latestSnapshot());
  if (process.argv.includes('--check')) {
    let current = '';
    try {
      current = readFileSync(TARGET, 'utf8');
    } catch {
      // missing
    }
    if (current !== doc) {
      console.error('docs/schema.md is out of date — run pnpm db:doc');
      process.exit(1);
    }
    console.log('docs/schema.md: in sync');
    return;
  }
  writeFileSync(TARGET, doc);
  console.log(`docs/schema.md: ${doc.length} bytes written`);
};

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href) {
  main();
}
