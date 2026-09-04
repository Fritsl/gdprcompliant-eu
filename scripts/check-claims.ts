// pnpm check:claims (O-03)
//
// Claim discipline, on every push. Three rules, one exit code:
//
//   1. No banned claim in customer-facing content, in any locale: never certified, never
//      approved, never a verdict of compliance, never a guarantee or a seal, never a named
//      third party called unlawful. The vocabulary is packages/i18n/content/claims.json;
//      the only allowed uses are the disclaimers, listed there with their reason.
//   2. A finding about a third party (a detector in the recipients family) is phrased as
//      observed behaviour plus a cited decision: its binding in every jurisdiction carries
//      a decision that resolves in the corpus registry.
//   3. The disclaimer exists in every locale the product speaks, in the shell footer and in
//      the shared document disclaimer.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DISCLAIMER } from '@gc/artefacts';
import { loadDecisions } from '@gc/corpus';
import { loadBindingTables } from '@gc/findings';
import { LOCALES, auditClaims, contentFiles, loadClaimVocabulary } from '@gc/i18n';

const root = process.cwd();
const problems: string[] = [];

// 1. The vocabulary over the content set.
const vocab = loadClaimVocabulary();
const files = contentFiles(root);
const audit = auditClaims(root, files, vocab);
for (const p of audit.problems) {
  problems.push(`${p.file} ${p.path} [${p.locale}]: "${p.match}" — ${p.why}`);
}
for (const a of audit.unusedAllowances) {
  problems.push(`claims.json allows ${a.file} ${a.path || '(whole file)'} but nothing there needs it`);
}

// 2. Third-party findings cite a decision, in every jurisdiction.
const raw: unknown = JSON.parse(
  readFileSync(join(root, 'packages', 'findings', 'content', 'detectors.json'), 'utf8'),
);
const detectors = (Array.isArray(raw) ? raw : (raw as { detectors: unknown[] }).detectors) as {
  findingTypeId: string;
  detector: string;
}[];
const thirdParty = detectors
  .filter((d) => d.detector.startsWith('scanner/checks/recipients#'))
  .map((d) => d.findingTypeId);
const registry = loadDecisions();
const known = new Set(registry.decisions.map((d) => `${d.body}:${d.reference}`));
const tables = loadBindingTables();
for (const [jurisdiction, table] of tables) {
  for (const type of thirdParty) {
    const row = table.bindings.find((b) => b.findingTypeId === type);
    if (!row) continue; // finding completeness reports the gap
    const decisions = row.citations.filter((c) => /^(case law|decision|judgment)$/i.test(c.instrument));
    if (decisions.length === 0) {
      problems.push(`${jurisdiction} ${type}: a finding about a third party cites a decision, and this binding cites none`);
      continue;
    }
    for (const c of decisions) {
      const m = /^([^,]+),\s*(.+)$/.exec(c.ref.trim());
      const key = m ? `${m[1]!.trim()}:${m[2]!.trim()}` : c.ref;
      if (!known.has(key)) problems.push(`${jurisdiction} ${type}: decision "${c.ref}" is not in the corpus registry`);
    }
  }
}

// 3. The disclaimer, everywhere, in every locale.
const locales = LOCALES.map((l) => l.code);
const messages = JSON.parse(readFileSync(join(root, 'apps', 'web', 'content', 'messages.json'), 'utf8')) as Record<
  string,
  Record<string, string>
>;
const footer = messages['shell.footer.notCertification'];
for (const locale of locales) {
  if (!footer?.[locale]) problems.push(`shell.footer.notCertification has no ${locale} text`);
  if (!DISCLAIMER[locale]) problems.push(`the document disclaimer has no ${locale} text`);
}

if (problems.length > 0) {
  console.error(`claims: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log(
  `claims: ${audit.files} content files, ${audit.strings} localised strings, ${vocab.banned.length} banned patterns, ${vocab.allow.length} allowed uses; ${thirdParty.length} third-party finding types cite a decision in ${tables.size} jurisdictions; the disclaimer speaks ${locales.join(', ')}`,
);
