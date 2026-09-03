#!/usr/bin/env node
// A new table without a row-level-security policy fails CI (F-05).
//
//   node scripts/rls-check.mjs
//
// Reads the tables from the latest Drizzle snapshot and the committed migrations, and
// demands, for every table: ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY, and at
// least one CREATE POLICY. The journal table Drizzle keeps for itself is exempt.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../packages/db/migrations/', import.meta.url));

export function tablesInSnapshot(dir = MIGRATIONS_DIR) {
  const meta = join(dir, 'meta');
  const files = readdirSync(meta)
    .filter((f) => f.endsWith('_snapshot.json'))
    .sort();
  const latest = files[files.length - 1];
  if (!latest) throw new Error('no snapshot');
  const snapshot = JSON.parse(readFileSync(join(meta, latest), 'utf8'));
  return Object.values(snapshot.tables).map((t) => t.name);
}

export function migrationsSql(dir = MIGRATIONS_DIR) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n');
}

const q = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// { table: { enabled, forced, policies } } for every table.
export function rlsCoverage(tables, sql) {
  const out = {};
  for (const t of tables) {
    out[t] = {
      enabled: new RegExp(`ALTER TABLE "${q(t)}" ENABLE ROW LEVEL SECURITY`).test(sql),
      forced: new RegExp(`ALTER TABLE "${q(t)}" FORCE ROW LEVEL SECURITY`).test(sql),
      policies: (sql.match(new RegExp(`CREATE POLICY "[^"]+" ON "${q(t)}"`, 'g')) ?? []).length,
    };
  }
  return out;
}

export function rlsProblems(coverage) {
  const problems = [];
  for (const [table, c] of Object.entries(coverage)) {
    if (!c.enabled) problems.push(`${table}: row level security is not enabled`);
    if (!c.forced) problems.push(`${table}: row level security is not forced for the owner`);
    if (c.policies === 0) problems.push(`${table}: no policy`);
  }
  return problems;
}

const main = () => {
  const tables = tablesInSnapshot();
  const coverage = rlsCoverage(tables, migrationsSql());
  const problems = rlsProblems(coverage);
  for (const [t, c] of Object.entries(coverage)) {
    console.log(`  ${t.padEnd(24)} ${c.enabled ? 'enabled' : 'NOT ENABLED'} ${c.forced ? 'forced' : 'NOT FORCED'} ${c.policies} polic${c.policies === 1 ? 'y' : 'ies'}`);
  }
  if (problems.length > 0) {
    console.error(`\nrls: ${problems.length} problem(s)\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`rls: every one of ${tables.length} tables is enabled, forced, and has a policy`);
};

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href) {
  main();
}
