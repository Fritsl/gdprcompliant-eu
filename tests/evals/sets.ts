import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The behavioural eval sets (T-05), declared once: which judgement site each set
// measures, where its scenarios live, how many there must be, and the share that must
// agree with the labels before a prompt change may ship. The eval tests read their
// thresholds from here, the registry test holds every set to its minimum and checks
// that every scenario carries its reasoning, and TESTING.md's table is compared with
// this file so the documentation cannot drift from what CI enforces.

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));

export const MIN_SCENARIOS = 20;

export type EvalSetId = 'policy-clauses' | 'dpa-analysis' | 'planner' | 'verifier';

export interface EvalScenario {
  readonly label: string;
  readonly reasoning: string;
}

export interface EvalSet {
  readonly id: EvalSetId;
  readonly name: string;
  // The task the judgement site came from.
  readonly task: string;
  // The share of scenarios the model (or the heuristic) must agree with the labels on.
  readonly threshold: number;
  // How the threshold reads in the documentation table.
  readonly measure: string;
  readonly test: string;
  // Every labelled scenario, with the reasoning written beside it.
  readonly scenarios: () => Promise<readonly EvalScenario[]>;
}

const jsonFiles = (dir: string) =>
  readdirSync(join(ROOT, dir))
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(ROOT, dir, f), 'utf8')) as Record<string, unknown>);

const fromFixtures = (dir: string) => async () =>
  jsonFiles(dir).map((p) => ({
    label: String(p['name']),
    reasoning: String(p['reasoning'] ?? ''),
  }));

export const EVAL_SETS: readonly EvalSet[] = [
  {
    id: 'policy-clauses',
    name: 'Policy clause analysis',
    task: 'S-10',
    threshold: 0.95,
    measure: 'agreement',
    test: 'tests/evals/policy-clauses.test.ts',
    scenarios: fromFixtures('fixtures/policies'),
  },
  {
    id: 'dpa-analysis',
    name: 'Processing agreement analysis',
    task: 'D-06',
    threshold: 0.95,
    measure: 'agreement',
    test: 'tests/evals/dpa-analysis.test.ts',
    scenarios: fromFixtures('fixtures/agreements'),
  },
  {
    id: 'planner',
    name: 'Planner next-action',
    task: 'A-06',
    threshold: 0.9,
    measure: 'sensible',
    test: 'tests/evals/planner.test.ts',
    scenarios: async () => {
      const f = JSON.parse(
        readFileSync(join(ROOT, 'fixtures', 'planner', 'scenarios.json'), 'utf8'),
      ) as { scenarios: { name: string; reasoning?: string }[] };
      return f.scenarios.map((s) => ({ label: s.name, reasoning: s.reasoning ?? '' }));
    },
  },
  {
    id: 'verifier',
    name: 'Verifier rejection',
    task: 'A-07',
    threshold: 0.98,
    measure: 'rejected',
    test: 'tests/evals/verifier.test.ts',
    // The claims are built in code, each with the reason it must pass or be stopped.
    scenarios: async () => {
      const m = await import('./verifier-scenarios.js');
      return [...m.TRUE_CLAIMS, ...m.POISONED_CLAIMS].map((s) => ({
        label: s.label,
        reasoning: s.why,
      }));
    },
  },
];

export const evalSet = (id: EvalSetId): EvalSet => EVAL_SETS.find((s) => s.id === id)!;
export const thresholdOf = (id: EvalSetId): number => evalSet(id).threshold;
