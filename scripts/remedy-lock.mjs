#!/usr/bin/env node
// Record the remedy catalogue's versions and content hashes in content/remedies/catalogue.lock.json.
//
//   node scripts/remedy-lock.mjs           refresh the lock; refuses a content change without a version bump
//   node scripts/remedy-lock.mjs --check   exit 1 if the lock does not match the content
//
// Plain JavaScript so it runs without a build. The canonicalisation here must match
// packages/remedies/src/canonical.ts byte for byte; tests/unit/remedies proves it does.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(new URL('../packages/remedies/content/remedies/', import.meta.url));
const LOCK = join(DIR, 'catalogue.lock.json');
const check = process.argv.includes('--check');

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

const current = {};
for (const file of readdirSync(DIR).filter((f) => f.endsWith('.json') && f !== 'catalogue.lock.json').sort()) {
  const { version, ...content } = JSON.parse(readFileSync(join(DIR, file), 'utf8'));
  const id = file.replace(/\.json$/, '');
  current[id] = { version, hash: sha256(canonicalJson(content)) };
}

let previous = { entries: {} };
try {
  previous = JSON.parse(readFileSync(LOCK, 'utf8'));
} catch {
  // No lock yet: every entry is new.
}

const problems = [];
for (const [id, now] of Object.entries(current)) {
  const was = previous.entries[id];
  if (!was) {
    if (check) problems.push(`${id}: new remedy, not in the lock`);
    continue;
  }
  const changed = was.hash !== now.hash;
  if (now.version < was.version) problems.push(`${id}: version went backwards (${was.version} → ${now.version})`);
  else if (changed && now.version === was.version) problems.push(`${id}: content changed without a version bump (still ${now.version})`);
  else if (!changed && now.version > was.version) problems.push(`${id}: version bumped to ${now.version} without a content change`);
  else if (check && changed) problems.push(`${id}: changed to version ${now.version} but the lock was not refreshed`);
}
for (const id of Object.keys(previous.entries)) {
  if (!current[id] && check) problems.push(`${id}: removed from the catalogue but still in the lock`);
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}

if (check) {
  console.log(`remedy lock: ${Object.keys(current).length} entries match`);
} else {
  writeFileSync(LOCK, `${JSON.stringify({ entries: current }, null, 2)}\n`);
  console.log(`remedy lock: ${Object.keys(current).length} entries written`);
}
