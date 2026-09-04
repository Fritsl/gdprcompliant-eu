import {
  DutySchema,
  type Citation,
  type Duty,
  type DutyStatus,
  type EvidenceRef,
  type Jurisdiction,
} from '@gc/contracts';
import { citationFromRow } from '@gc/findings';
import type { Facts } from './facts.js';
import { factsRead, type Condition, type FactTest, type Rule, type RuleSet } from './language.js';

// The engine (A-02). Three-valued: a condition over a fact the sheet does not hold is
// unknown, not false, and a rule whose condition is unknown gives an undetermined duty.
// Evaluation reads only the fact sheet and the rule sets, so the same sheet under the
// same jurisdiction gives the same duties, in the same order, every time.

export type Verdict = 'true' | 'false' | 'unknown';

const isScalar = (v: unknown): v is string | number | boolean =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

export function testFact(t: FactTest, facts: Facts): Verdict {
  const actual = facts[t.fact];
  if (t.op === 'exists') return actual === undefined ? 'false' : 'true';
  if (actual === undefined) return 'unknown';
  const expected = t.value;
  switch (t.op) {
    case 'empty':
      return (Array.isArray(actual) ? actual.length === 0 : actual === '') ? 'true' : 'false';
    case 'eq':
      return actual === expected ? 'true' : 'false';
    case 'ne':
      return actual !== expected ? 'true' : 'false';
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      if (typeof actual !== 'number' || typeof expected !== 'number') return 'unknown';
      const r =
        t.op === 'gt'
          ? actual > expected
          : t.op === 'gte'
            ? actual >= expected
            : t.op === 'lt'
              ? actual < expected
              : actual <= expected;
      return r ? 'true' : 'false';
    }
    case 'in':
      return Array.isArray(expected) && isScalar(actual) && (expected as unknown[]).includes(actual)
        ? 'true'
        : 'false';
    case 'contains':
      if (Array.isArray(actual)) return (actual as unknown[]).includes(expected) ? 'true' : 'false';
      if (typeof actual === 'string' && typeof expected === 'string')
        return actual.includes(expected) ? 'true' : 'false';
      return 'unknown';
  }
}

export function evaluateCondition(c: Condition | 'always', facts: Facts): Verdict {
  if (c === 'always') return 'true';
  if ('all' in c) {
    const vs = c.all.map((x) => evaluateCondition(x, facts));
    if (vs.includes('false')) return 'false';
    return vs.includes('unknown') ? 'unknown' : 'true';
  }
  if ('any' in c) {
    const vs = c.any.map((x) => evaluateCondition(x, facts));
    if (vs.includes('true')) return 'true';
    return vs.includes('unknown') ? 'unknown' : 'false';
  }
  if ('not' in c) {
    const v = evaluateCondition(c.not, facts);
    return v === 'unknown' ? 'unknown' : v === 'true' ? 'false' : 'true';
  }
  return testFact(c, facts);
}

// A rule's status on a fact sheet. `unless` that holds wins; `unless` that is unknown
// leaves the duty undetermined, because it might.
export function statusOf(rule: Rule, facts: Facts): DutyStatus {
  const when = evaluateCondition(rule.when, facts);
  if (when === 'false') return 'not_applicable';
  if (rule.unless) {
    const unless = evaluateCondition(rule.unless, facts);
    if (unless === 'true') return 'not_applicable';
    if (unless === 'unknown') return 'undetermined';
  }
  return when === 'true' ? 'applies' : 'undetermined';
}

export function citationsOf(rule: Rule): Citation[] {
  return rule.citations.map((c) =>
    citationFromRow({ instrument: c.instrument, ref: c.ref, ...(c.note ? { note: c.note } : {}) }),
  );
}

export interface EvaluateInput {
  readonly caseId: string;
  readonly jurisdiction: Jurisdiction;
  readonly facts: Facts;
  readonly evidence?: readonly EvidenceRef[];
  readonly questionIds?: readonly string[];
}

// The rule sets that speak in a jurisdiction: the Union set and the country's own.
export function setsFor(sets: readonly RuleSet[], jurisdiction: Jurisdiction): RuleSet[] {
  return sets
    .filter((s) => s.jurisdiction === 'EU' || s.jurisdiction === jurisdiction)
    .sort((a, b) => (a.jurisdiction === 'EU' ? -1 : b.jurisdiction === 'EU' ? 1 : 0));
}

// Every rule gives a duty; nothing is skipped and nothing throws on a missing fact.
export function evaluate(sets: readonly RuleSet[], input: EvaluateInput): Duty[] {
  const duties: Duty[] = [];
  for (const set of setsFor(sets, input.jurisdiction)) {
    for (const rule of [...set.rules].sort((a, b) => a.id.localeCompare(b.id))) {
      duties.push(
        DutySchema.parse({
          id: `duty:${input.caseId}:${set.jurisdiction}:${rule.id}`,
          caseId: input.caseId,
          ruleId: rule.id,
          ruleVersion: `${set.jurisdiction}@${set.version}`,
          jurisdiction: input.jurisdiction,
          title: rule.title,
          status: statusOf(rule, input.facts),
          citations: citationsOf(rule),
          because: {
            evidence: [...(input.evidence ?? [])],
            questionIds: [...(input.questionIds ?? [])],
          },
          findingTypeIds: rule.findingTypeIds,
        }),
      );
    }
  }
  return duties;
}

export interface ExampleResult {
  readonly set: string;
  readonly ruleId: string;
  readonly example: string;
  readonly expected: DutyStatus;
  readonly actual: DutyStatus;
  readonly ok: boolean;
}

// Every example of every rule, evaluated; the check and the suite read the list.
export function runExamples(sets: readonly RuleSet[]): ExampleResult[] {
  const out: ExampleResult[] = [];
  for (const set of sets) {
    for (const rule of set.rules) {
      for (const ex of rule.examples) {
        const actual = statusOf(rule, ex.facts as Facts);
        out.push({
          set: `${set.jurisdiction}@${set.version}`,
          ruleId: rule.id,
          example: ex.name,
          expected: ex.expect,
          actual,
          ok: actual === ex.expect,
        });
      }
    }
  }
  return out;
}

// The facts a rule set reads, for the reviewer and for the fact sheet's coverage.
export const factsUsed = (sets: readonly RuleSet[]): string[] =>
  [
    ...new Set(
      sets.flatMap((s) =>
        s.rules.flatMap((r) => [...factsRead(r.when), ...(r.unless ? factsRead(r.unless) : [])]),
      ),
    ),
  ].sort();
