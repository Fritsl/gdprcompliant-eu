import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The shapes in @gc/contracts are defined once. This test reads every other package and
// app and fails if one of them grows a local Finding, or generates its own JSON Schema.

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', 'artifacts']);

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mts)$/.test(entry) && !/\.d\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

const CONTRACT_NAMES = [
  'Finding',
  'Evidence',
  'EvidenceRef',
  'Remedy',
  'Case',
  'CaseEvent',
  'Vendor',
  'Duty',
  'PlannerTask',
  'VerifierVerdict',
  'Claim',
  'Citation',
];

const contractsSrc = join(ROOT, 'packages', 'contracts', 'src');
const elsewhere = [join(ROOT, 'packages'), join(ROOT, 'apps')]
  .flatMap((d) => walk(d))
  .filter((f) => !f.startsWith(contractsSrc) && !f.includes(`${sep}prototype${sep}`));

const rel = (f: string) => relative(ROOT, f);

describe('one definition of every shape (F-04)', () => {
  it('the contracts package exports each shape as a type', () => {
    const src = walk(contractsSrc)
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');
    for (const name of CONTRACT_NAMES) {
      expect(src, `contracts do not export type ${name}`).toMatch(
        new RegExp(`export type ${name} =`),
      );
    }
  });

  it('no other package or app redefines a contract shape', () => {
    // A declaration is followed by `=`, `{`, `extends` or type parameters. An import
    // specifier (`type Remedy,`) is not, and is exactly how the shape should be used.
    const redefinition = new RegExp(
      `\\b(?:interface|type)\\s+(?:${CONTRACT_NAMES.join('|')})\\s*(?:<|=|\\{|extends\\b)`,
    );
    const offenders = elsewhere.filter((f) => redefinition.test(readFileSync(f, 'utf8')));
    expect(offenders.map(rel)).toEqual([]);
  });

  it('JSON Schema is generated only in the contracts package', () => {
    const generator = /toJSONSchema\(|zodToJsonSchema|zod-to-json-schema|"\$schema"\s*:/;
    const offenders = elsewhere.filter((f) => generator.test(readFileSync(f, 'utf8')));
    expect(offenders.map(rel)).toEqual([]);
  });
});
