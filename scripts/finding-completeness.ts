// pnpm run check:finding-completeness (R-02)
//
// A finding without a remedy cannot exist. The database refuses it (findings.remedy_id
// is NOT NULL, F-03), the type refuses it (Finding requires a remedy ref, F-04), and this
// check refuses to let a detector or a fixture promise a finding the catalogue cannot
// answer in every supported jurisdiction.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { FindingSchema } from '@gc/contracts';
import { DETECTORS, bindingCoverage, checkFindingCompleteness } from '@gc/findings';
import { loadCatalogue } from '@gc/remedies';

const problems: string[] = [];

// 1. The type: a Finding cannot be built without a remedy reference.
const withoutRemedy = FindingSchema.safeParse({
  id: 'f',
  tenantId: 't',
  caseId: 'DK-26-0M4K',
  typeId: 'CNS-02',
  fingerprint: 'x',
  jurisdiction: 'DK',
  binding: {
    findingTypeId: 'CNS-02',
    jurisdiction: 'DK',
    citations: [{ kind: 'provision', instrument: 'ePrivacy', article: '5', ref: 'Art. 5(3)' }],
    authority: { name: 'x' },
    guideId: 'x',
    version: 1,
  },
  severity: 'blocking',
  status: 'open',
  area: 'Consent',
  evidence: [{ evidenceId: 'e', hash: 'a'.repeat(64) }],
  firstSeenAt: '2026-09-03T00:00:00Z',
  lastSeenAt: '2026-09-03T00:00:00Z',
});
if (withoutRemedy.success) problems.push('FindingSchema accepted a finding without a remedy');

// 2. The database: the migration declares the NOT NULL column and the foreign key.
const migrations = join(process.cwd(), 'packages', 'db', 'migrations');
const sql = readdirSync(migrations)
  .filter((f) => f.endsWith('.sql'))
  .map((f) => readFileSync(join(migrations, f), 'utf8'))
  .join('\n');
if (!/"remedy_id" text NOT NULL/.test(sql)) problems.push('migrations: findings.remedy_id is not NOT NULL');
if (!/"remedy_version" integer NOT NULL/.test(sql)) problems.push('migrations: findings.remedy_version is not NOT NULL');
if (!/CONSTRAINT "findings_remedy_fk" FOREIGN KEY \("remedy_id","remedy_version"\) REFERENCES "remedies"/.test(sql)) {
  problems.push('migrations: findings has no foreign key to remedies');
}

// 3. The catalogue: every registered or promised finding type, in every jurisdiction.
const catalogue = loadCatalogue();
const result = checkFindingCompleteness(catalogue);
console.log(
  `finding completeness — ${result.findingTypes.length} finding types (${DETECTORS.length} detectors registered), ${result.jurisdictions.join(', ')}`,
);
for (const id of result.findingTypes) {
  const cover = result.jurisdictions.map((j) => `${j}:${catalogue.forFinding(id, j).length}`).join(' ');
  console.log(`  ${id.padEnd(8)} ${cover}`);
}
for (const gap of result.gaps) {
  problems.push(`${gap.findingTypeId} has no remedy in ${gap.jurisdiction} (promised by ${gap.promisedBy.join(', ')})`);
}

// 4. The bindings (I-02): every promised finding type is bound in every supported
// jurisdiction — the provisions, the authority, the guide — as content.
for (const gap of bindingCoverage(result.findingTypes, result.jurisdictions)) {
  problems.push(`${gap.findingTypeId} has no jurisdiction binding in ${gap.jurisdiction}`);
}

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
console.log('every finding the product can raise has a remedy and a binding in every supported jurisdiction');
