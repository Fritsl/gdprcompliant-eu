import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DutyStatus, Jurisdiction } from '@gc/contracts';
import { documentChunks, loadCorpusDocuments, resolveInChunks } from '@gc/corpus';
import {
  citationsOf,
  evaluate,
  loadRuleSets,
  runExamples,
  setsFor,
  type Facts,
  type RuleSet,
} from '@gc/rules';

// The rule corpus (A-03): at least forty rules, each with a citation that resolves, a
// worked example that passes and a jurisdiction it speaks in; at least six where a
// Danish and a German company with the same facts get different duties; and a golden
// duty set for three synthetic companies per jurisdiction, so a change to any rule
// shows up as a diff a reviewer reads.

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const sets = loadRuleSets();
const chunks = loadCorpusDocuments().flatMap(documentChunks);
const fixture = JSON.parse(
  readFileSync(join(ROOT, 'fixtures', 'rules', 'companies.json'), 'utf8'),
) as { companies: { id: string; jurisdiction: Jurisdiction; facts: Facts }[] };
const GOLDEN = join(ROOT, 'fixtures', 'rules', 'golden.json');

const dutiesOf = (facts: Facts, jurisdiction: Jurisdiction): Record<string, DutyStatus> =>
  Object.fromEntries(
    evaluate(sets, { caseId: 'DK-26-GOLD', jurisdiction, facts }).map((d) => [d.ruleId, d.status]),
  );
const allRules = (s: readonly RuleSet[]) =>
  s.flatMap((set) => set.rules.map((r) => ({ set: set.jurisdiction, rule: r })));

describe('forty rules', () => {
  it('are there, each with a citation, an example and a jurisdiction', () => {
    const rules = allRules(sets);
    expect(rules.length).toBeGreaterThanOrEqual(40);
    for (const { set, rule } of rules) {
      expect(['EU', 'DK', 'DE']).toContain(set);
      expect(rule.citations.length, rule.id).toBeGreaterThan(0);
      expect(rule.examples.length, rule.id).toBeGreaterThan(0);
      expect(rule.title['en'], rule.id).toBeTruthy();
      expect(rule.summary['en'], rule.id).toBeTruthy();
    }
    const ids = rules.map((r) => r.rule.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every citation resolves to a real paragraph in the jurisdiction the set speaks in', () => {
    for (const set of sets)
      for (const rule of set.rules)
        for (const c of citationsOf(rule)) {
          const r = resolveInChunks(chunks, c, set.jurisdiction === 'EU' ? 'DK' : set.jurisdiction);
          expect(r.ok, `${set.jurisdiction} ${rule.id}: ${c.ref}`).toBe(true);
        }
  });

  it('every worked example passes', () => {
    const failing = runExamples(sets).filter((e) => !e.ok);
    expect(failing.map((e) => `${e.ruleId}/${e.example}: ${e.expected} ≠ ${e.actual}`)).toEqual([]);
    expect(runExamples(sets).length).toBeGreaterThanOrEqual(100);
  });

  it('Denmark and Germany genuinely differ on at least six rules for the same facts', () => {
    const differing = new Set<string>();
    for (const c of fixture.companies) {
      const dk = dutiesOf(c.facts, 'DK');
      const de = dutiesOf(c.facts, 'DE');
      for (const id of new Set([...Object.keys(dk), ...Object.keys(de)])) {
        const a = dk[id] ?? 'not_applicable';
        const b = de[id] ?? 'not_applicable';
        if (a !== b && (a === 'applies' || b === 'applies')) differing.add(id);
      }
    }
    expect(differing.size).toBeGreaterThanOrEqual(6);
    // The difference is real law, not a country tag: the age of consent, the officer
    // threshold, the employment regime, the works council, the national number.
    for (const id of [
      'parental-consent-under-16',
      'dpo-twenty-persons',
      'employee-data-regime',
      'cpr-number-handling',
    ])
      expect([...differing], id).toContain(id);
    // The Union rules apply the same way in both.
    for (const rule of setsFor(sets, 'DK').find((s) => s.jurisdiction === 'EU')!.rules)
      expect([...differing]).not.toContain(rule.id);
  });
});

describe('the golden duty sets', () => {
  const computed = fixture.companies.map((c) => ({
    id: c.id,
    jurisdiction: c.jurisdiction,
    duties: dutiesOf(c.facts, c.jurisdiction),
  }));

  it('three companies per jurisdiction, and every one gets a duty list a person can read', () => {
    expect(fixture.companies.filter((c) => c.jurisdiction === 'DK')).toHaveLength(3);
    expect(fixture.companies.filter((c) => c.jurisdiction === 'DE')).toHaveLength(3);
    for (const c of computed) {
      const applies = Object.values(c.duties).filter((s) => s === 'applies').length;
      expect(applies, c.id).toBeGreaterThanOrEqual(10);
      expect(
        Object.values(c.duties).filter((s) => s === 'undetermined').length,
        c.id,
      ).toBeLessThanOrEqual(3);
    }
  });

  it('match the golden file; set UPDATE_GOLDEN=1 to rewrite it after a deliberate change', () => {
    if (process.env['UPDATE_GOLDEN'] === '1' || !existsSync(GOLDEN)) {
      writeFileSync(
        GOLDEN,
        JSON.stringify(
          {
            _comment:
              'The duty set the rules give each synthetic company. Regenerate with UPDATE_GOLDEN=1 after a deliberate rule change, and read the diff.',
            rules: allRules(sets).length,
            companies: computed,
          },
          null,
          2,
        ) + '\n',
      );
    }
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as {
      rules: number;
      companies: typeof computed;
    };
    expect(golden.rules).toBe(allRules(sets).length);
    expect(computed).toEqual(golden.companies);
  });

  it('a Danish company and its German twin differ where the golden says, and nowhere else', () => {
    for (const dk of computed.filter((c) => c.jurisdiction === 'DK')) {
      const de = computed.find((c) => c.id === dk.id.replace(/^dk-/, 'de-'))!;
      const only = (a: Record<string, DutyStatus>, b: Record<string, DutyStatus>) =>
        Object.keys(a).filter(
          (k) => a[k] === 'applies' && (b[k] ?? 'not_applicable') !== 'applies',
        );
      const dkOnly = only(dk.duties, de.duties);
      const deOnly = only(de.duties, dk.duties);
      expect(
        dkOnly.every(
          (id) =>
            id.startsWith('dk-') ||
            ['cpr-number-handling', 'parental-consent-under-13'].includes(id),
        ),
        dkOnly.join(),
      ).toBe(true);
      expect(
        deOnly.every(
          (id) =>
            id.startsWith('de-') ||
            [
              'dpo-twenty-persons',
              'employee-data-regime',
              'works-council-consultation',
              'parental-consent-under-16',
            ].includes(id),
        ),
        deOnly.join(),
      ).toBe(true);
    }
  });
});
