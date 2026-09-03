#!/usr/bin/env node
// A table without a retention rule fails CI (O-02).
//
//   node --import tsx scripts/retention-check.mjs
//
// Reads the tables from the latest Drizzle snapshot and the declarations in
// packages/db/src/retention.ts, and demands one rule per table and no rule for a table
// that does not exist.

import { tablesInSnapshot } from './rls-check.mjs';

export async function retentionProblems() {
  const { RETENTION } = await import('../packages/db/src/retention.ts');
  const tables = tablesInSnapshot();
  const declared = Object.keys(RETENTION);
  const problems = [];
  for (const t of tables) if (!(t in RETENTION)) problems.push(`${t}: no retention rule`);
  for (const d of declared) if (!tables.includes(d)) problems.push(`${d}: rule for a table that does not exist`);
  return { tables, declared, problems, RETENTION };
}

const main = async () => {
  const { tables, problems, RETENTION } = await retentionProblems();
  for (const t of tables) {
    const rule = RETENTION[t];
    console.log(`  ${t.padEnd(24)} ${rule ? JSON.stringify(rule) : 'NO RULE'}`);
  }
  if (problems.length > 0) {
    console.error(`\nretention: ${problems.length} problem(s)\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`retention: every one of ${tables.length} tables declares its lifetime`);
};

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
