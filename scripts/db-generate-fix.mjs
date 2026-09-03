#!/usr/bin/env node
// drizzle-kit qualifies foreign-key targets as "public"."table". Migrations here run
// inside whatever schema is first on search_path (a test schema of its own per file),
// so the qualifier is removed. Runs after every pnpm db:generate.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../packages/db/migrations/', import.meta.url));
let changed = 0;
for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql'))) {
  const before = readFileSync(join(dir, file), 'utf8');
  const after = before.replaceAll('"public".', '');
  if (after !== before) {
    writeFileSync(join(dir, file), after);
    changed++;
  }
}
console.log(`db-generate-fix: ${changed} migration(s) unqualified`);
