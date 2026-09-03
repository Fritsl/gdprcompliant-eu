// The test suites, tagged. vitest.workspace.ts builds one project per entry, and the
// delivery gate (O-05) reads the same list to decide what must be green before a
// handover. Change a suite here and nowhere else.

export type SuiteNeed = 'database' | 'cassettes' | 'browser' | 'model';

export interface Suite {
  readonly name: string;
  // required: red stops the gate. nightly: runs on a schedule, informs, never blocks.
  readonly gate: 'required' | 'nightly';
  // What has to be present for the suite to run at all. Unit needs nothing: no
  // database, no network, no browser — and the harness enforces that.
  readonly needs: readonly SuiteNeed[];
  // Wall-clock budget for the whole suite, enforced by the gate.
  readonly budgetSeconds: number;
  readonly testTimeoutMs: number;
}

export const SUITES: readonly Suite[] = [
  { name: 'unit', gate: 'required', needs: [], budgetSeconds: 30, testTimeoutMs: 5_000 },
  {
    name: 'integration',
    gate: 'required',
    needs: ['database', 'cassettes'],
    budgetSeconds: 300,
    testTimeoutMs: 30_000,
  },
  {
    name: 'e2e',
    gate: 'required',
    needs: ['database', 'cassettes', 'browser'],
    budgetSeconds: 900,
    testTimeoutMs: 60_000,
  },
  {
    name: 'evals',
    gate: 'required',
    needs: ['model'],
    budgetSeconds: 1_800,
    testTimeoutMs: 120_000,
  },
  {
    name: 'adversarial',
    gate: 'required',
    needs: ['cassettes', 'browser'],
    budgetSeconds: 600,
    testTimeoutMs: 60_000,
  },
  {
    name: 'perf',
    gate: 'nightly',
    needs: ['database', 'cassettes', 'browser'],
    budgetSeconds: 3_600,
    testTimeoutMs: 300_000,
  },
];

// Where the reports land. The gate reads them; CI uploads the directory.
export const ARTIFACTS = {
  junit: 'artifacts/junit.xml',
  html: 'artifacts/report/index.html',
  coverage: 'artifacts/coverage',
} as const;

// Coverage floors. Findings, rules and remedies are where a wrong line becomes a wrong
// claim to a customer, so they carry the higher floor.
export const COVERAGE_FLOOR = 70;
export const COVERAGE_FLOOR_CRITICAL = 85;
export const COVERAGE_CRITICAL_PACKAGES = ['findings', 'rules', 'remedies'] as const;
