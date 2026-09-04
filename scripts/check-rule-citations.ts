// pnpm check:rule-citations (A-02)
//
// Every rule in every rule set cites at least one provision, every citation resolves to
// a real paragraph of the corpus as published, in the jurisdiction the set speaks in,
// and every rule's worked examples give the status the rule says they do. A rule that
// fails any of these fails the build: a rule cannot be added without a citation that
// resolves and a test case that passes.

import { documentChunks, loadCorpusDocuments, resolveInChunks } from '@gc/corpus';
import { citationsOf, factsUsed, loadRuleSets, runExamples, FACT_NAMES } from '@gc/rules';

const sets = loadRuleSets();
const chunks = loadCorpusDocuments().flatMap(documentChunks);
const problems: string[] = [];
let citations = 0;

for (const set of sets) {
  for (const rule of set.rules) {
    let typed;
    try {
      typed = citationsOf(rule);
    } catch (e) {
      problems.push(`${set.jurisdiction} ${rule.id}: ${(e as Error).message}`);
      continue;
    }
    for (const c of typed) {
      citations += 1;
      const r = resolveInChunks(chunks, c, set.jurisdiction === 'EU' ? 'DK' : set.jurisdiction);
      if (!r.ok)
        problems.push(
          `${set.jurisdiction} ${rule.id}: ${c.kind === 'provision' ? `${c.instrument} ${c.ref}` : c.ref} does not resolve (${r.reason})`,
        );
    }
  }
}

for (const ex of runExamples(sets)) {
  if (!ex.ok)
    problems.push(
      `${ex.set} ${ex.ruleId}, example "${ex.example}": expected ${ex.expected}, got ${ex.actual}`,
    );
}

// A rule may only read a fact the sheet can produce.
const known = new Set(Object.keys(FACT_NAMES));
for (const fact of factsUsed(sets)) {
  if (!known.has(fact)) problems.push(`a rule reads the fact ${fact}, which the fact sheet never produces`);
}

if (problems.length > 0) {
  console.error(`rule citations: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
const rules = sets.reduce((n, s) => n + s.rules.length, 0);
const examples = sets.reduce((n, s) => n + s.rules.reduce((m, r) => m + r.examples.length, 0), 0);
console.log(
  `rule citations: ${sets.length} rule set(s), ${rules} rule(s), ${citations} citation(s) resolve, ${examples} example(s) pass, ${factsUsed(sets).length} fact(s) read`,
);
