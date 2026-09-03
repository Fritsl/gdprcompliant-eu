import { describe, expect, it } from 'vitest';
import { PlanSchema, TASK_TYPES, type PlannerTask, type TaskType } from '@gc/contracts';
import {
  BudgetExceeded,
  Dispatcher,
  InvalidTaskProposal,
  SAMPLE_PAYLOADS,
  TASK_CATALOGUE,
  TASK_CATALOGUE_TYPES,
  UnknownTaskType,
  acceptProposal,
  costOf,
  topological,
  type TaskOutcome,
  type Workers,
} from '@gc/agent';

// The task catalogue and the dispatcher (A-04): the vocabulary is closed and loud about
// it, every task has a cost, and the dispatcher stops rather than overspend.

const NOW = new Date('2026-09-03T09:14:00Z');
const CASE = 'DK-26-0M4K';
const ref = { evidenceId: 'text:0000000000000001', hash: 'a'.repeat(64) };

const proposal = (type: TaskType) => ({
  type,
  payload: SAMPLE_PAYLOADS[type],
  rationale: `because ${type}`,
});

describe('the catalogue is closed', () => {
  it('has exactly one entry per task type in the contract, and each is constructible', () => {
    expect(TASK_CATALOGUE_TYPES.sort()).toEqual([...TASK_TYPES].sort());
    for (const type of TASK_TYPES) {
      const spec = TASK_CATALOGUE[type];
      expect(spec.type).toBe(type);
      expect(spec.maxAttempts).toBeGreaterThan(0);
      const payload = spec.payload.parse(SAMPLE_PAYLOADS[type]);
      const cost = spec.cost(payload as never);
      expect(cost.credits, type).toBeGreaterThan(0);
      const task = acceptProposal(proposal(type), { caseId: CASE, id: `t-${type}`, now: NOW });
      expect(task).toMatchObject({ type, status: 'pending', attempts: 0, cost });
    }
  });

  it('rejects an unknown type at the boundary, naming it and the vocabulary', () => {
    const bad = { type: 'hack_the_planet', payload: {}, rationale: 'why not' };
    expect(() => acceptProposal(bad, { caseId: CASE, id: 't', now: NOW })).toThrow(UnknownTaskType);
    expect(() => acceptProposal(bad, { caseId: CASE, id: 't', now: NOW })).toThrow(
      /"hack_the_planet" is not in the catalogue \(crawl, read_contract/,
    );
    expect(() => acceptProposal(null, { caseId: CASE, id: 't', now: NOW })).toThrow(
      UnknownTaskType,
    );
    expect(() => costOf({ type: 'nope' } as never)).toThrow(UnknownTaskType);
  });

  it('rejects a known type with a bad or padded payload, saying what is wrong', () => {
    const tooDeep = {
      type: 'crawl',
      payload: { ...SAMPLE_PAYLOADS.crawl, depth: 9 },
      rationale: 'x',
    };
    expect(() => acceptProposal(tooDeep, { caseId: CASE, id: 't', now: NOW })).toThrow(
      InvalidTaskProposal,
    );
    expect(() => acceptProposal(tooDeep, { caseId: CASE, id: 't', now: NOW })).toThrow(
      /payload\.depth/,
    );
    const padded = { ...proposal('draft'), cost: { credits: 0 }, id: 'model-picked' };
    expect(() => acceptProposal(padded, { caseId: CASE, id: 't', now: NOW })).toThrow(
      /Unrecognized key/,
    );
    const lookup = {
      type: 'registry_lookup',
      payload: { registry: 'cvr', query: {} },
      rationale: 'x',
    };
    expect(() => acceptProposal(lookup, { caseId: CASE, id: 't', now: NOW })).toThrow(
      /needs a name, an id or a domain/,
    );
  });

  it('costs follow the payload: a wider crawl costs more, a longer contract costs more', () => {
    const shallow = costOf({
      ...proposal('crawl'),
      payload: { ...SAMPLE_PAYLOADS.crawl, depth: 0, passes: ['A'] },
    });
    const wide = costOf({
      ...proposal('crawl'),
      payload: { ...SAMPLE_PAYLOADS.crawl, depth: 2, passes: ['A', 'B', 'C'] },
    });
    expect(wide.credits).toBeGreaterThan(shallow.credits * 5);
    const one = costOf(proposal('read_contract'));
    const five = costOf({
      ...proposal('read_contract'),
      payload: { documentEvidenceId: 'document:abc', questions: ['a', 'b', 'c', 'd', 'e'] },
    });
    expect(five.credits - one.credits).toBe(4);
    expect(costOf(proposal('verify_claims')).credits).toBe(2);
  });
});

const okOutcome = (task: PlannerTask, output: unknown): TaskOutcome => ({
  result: { taskId: task.id, type: task.type, claims: [], evidence: [], cost: task.cost },
  output,
});
const outputs: { [T in TaskType]: unknown } = {
  crawl: { passes: [{ pass: 'A', evidenceIds: ['e1'] }] },
  read_contract: { answers: [{ question: 'q', answer: 'a', evidence: ref }] },
  registry_lookup: { matches: [] },
  research: { passages: [] },
  draft: { artefactId: 'a-1', kind: 'privacy_policy' },
  verify_claims: {
    verdicts: [
      {
        claimId: 'claim-1',
        verdict: 'accepted',
        checks: [{ name: 'evidence_exists', passed: true }],
        at: NOW.toISOString(),
      },
    ],
  },
};

function workers(
  log: string[],
  overrides: Partial<Record<TaskType, (task: PlannerTask) => Promise<TaskOutcome>>> = {},
): Workers {
  const all: Record<string, (task: PlannerTask) => Promise<TaskOutcome>> = {};
  for (const type of TASK_TYPES) {
    all[type] =
      overrides[type] ??
      (async (task) => {
        log.push(task.id);
        return okOutcome(task, outputs[type]);
      });
  }
  return all as unknown as Workers;
}

describe('the dispatcher plans within budget', () => {
  it('builds a plan the schema accepts, with dependencies by position', () => {
    const d = new Dispatcher({
      budgets: { perCase: 500, perScan: 200 },
      workers: {},
      now: () => NOW,
    });
    const plan = d.plan(CASE, [
      { proposal: proposal('crawl') },
      { proposal: proposal('read_contract'), dependsOn: [0] },
      { proposal: proposal('verify_claims'), dependsOn: [1] },
    ]);
    expect(PlanSchema.safeParse(plan).success).toBe(true);
    expect(plan.tasks.map((t) => [t.id, t.dependsOn])).toEqual([
      ['task-1', []],
      ['task-2', ['task-1']],
      ['task-3', ['task-2']],
    ]);
    expect(plan.budget.credits).toBe(200);
    expect(() => d.plan(CASE, [{ proposal: proposal('crawl'), dependsOn: [0] }])).toThrow(
      /not before it/,
    );
  });

  it('refuses a plan the scan cannot afford, and one the case cannot, saying which', () => {
    const d = new Dispatcher({
      budgets: { perCase: 100, perScan: 30 },
      workers: {},
      now: () => NOW,
    });
    // crawl with the sample payload costs 40.
    expect(() => d.plan(CASE, [{ proposal: proposal('crawl') }])).toThrow(BudgetExceeded);
    try {
      d.plan(CASE, [{ proposal: proposal('crawl') }]);
    } catch (e) {
      expect(e).toMatchObject({ scope: 'scan', asked: 40, available: 30 });
    }
    const spent = new Dispatcher({
      budgets: { perCase: 10, perScan: 30 },
      workers: {},
      now: () => NOW,
    });
    try {
      spent.plan(CASE, [{ proposal: proposal('draft') }]);
    } catch (e) {
      expect(e).toMatchObject({ scope: 'case', asked: 15, available: 10 });
    }
  });
});

describe('the dispatcher runs and stops', () => {
  it('runs in dependency order, validates every output, and remembers case spend across scans', async () => {
    const log: string[] = [];
    const d = new Dispatcher({
      budgets: { perCase: 1000, perScan: 500 },
      workers: workers(log),
      now: () => NOW,
    });
    const plan = d.plan(CASE, [
      { proposal: proposal('verify_claims'), dependsOn: [] },
      { proposal: proposal('crawl') },
      { proposal: proposal('read_contract'), dependsOn: [1] },
    ]);
    // Put the dependent first to prove order comes from dependsOn, not the list.
    const reordered = { ...plan, tasks: [plan.tasks[2]!, plan.tasks[0]!, plan.tasks[1]!] };
    const report = await d.run(reordered, 'scan-1');
    expect(log).toEqual(['task-1', 'task-2', 'task-3']);
    expect(report.tasks.map((t) => [t.id, t.status])).toEqual([
      ['task-3', 'done'],
      ['task-1', 'done'],
      ['task-2', 'done'],
    ]);
    expect(report.spentThisScan).toBe(2 + 40 + 6);
    expect(report.spentOnCase).toBe(48);
    expect(report.stoppedBecause).toBeUndefined();
    expect(report.tasks.find((t) => t.id === 'task-1')?.output).toEqual(outputs.verify_claims);

    const second = await d.run(d.plan(CASE, [{ proposal: proposal('draft') }]), 'scan-2');
    expect(second.spentThisScan).toBe(15);
    expect(second.spentOnCase).toBe(63);
    expect(d.remainingForCase(CASE)).toBe(937);
  });

  it('a worker returning the wrong shape fails the task loudly; dependents are skipped', async () => {
    const log: string[] = [];
    const d = new Dispatcher({
      budgets: { perCase: 1000, perScan: 500 },
      workers: workers(log, { crawl: async (task) => okOutcome(task, { passes: [] }) }),
      now: () => NOW,
    });
    const report = await d.run(
      d.plan(CASE, [
        { proposal: proposal('crawl') },
        { proposal: proposal('read_contract'), dependsOn: [0] },
      ]),
      'scan-1',
    );
    expect(report.tasks[0]).toMatchObject({
      status: 'failed',
      attempts: 1,
      reason: expect.stringMatching(/^output rejected: passes/),
    });
    expect(report.tasks[1]).toMatchObject({
      status: 'skipped',
      reason: 'depends on task-1, which did not finish',
    });
    expect(log).toEqual([]);
  });

  it('retries a retryable failure up to the catalogue limit, paying each time, and not a final one', async () => {
    let calls = 0;
    const d = new Dispatcher({
      budgets: { perCase: 1000, perScan: 500 },
      workers: workers([], {
        registry_lookup: async () => {
          calls += 1;
          throw new Error(`registry down ${calls}`);
        },
        verify_claims: async (task) => ({
          result: {
            taskId: task.id,
            type: task.type,
            cost: task.cost,
            failure: { reason: 'claim ids unknown', retryable: false },
          },
          output: null,
        }),
      }),
      now: () => NOW,
    });
    const report = await d.run(
      d.plan(CASE, [
        { proposal: proposal('registry_lookup') },
        { proposal: proposal('verify_claims') },
      ]),
      'scan-1',
    );
    expect(calls).toBe(TASK_CATALOGUE.registry_lookup.maxAttempts);
    expect(report.tasks[0]).toMatchObject({
      status: 'failed',
      attempts: 3,
      reason: 'retryable: worker threw: registry down 3',
    });
    expect(report.tasks[1]).toMatchObject({
      status: 'failed',
      attempts: 1,
      reason: 'final: claim ids unknown',
    });
    expect(report.spentThisScan).toBe(2 * 3 + 2);
  });

  it('stops at the scan budget rather than overspend: the next task is skipped, the worker never called', async () => {
    const log: string[] = [];
    // crawl 40, draft 15, verify 2: the scan allows 50.
    const d = new Dispatcher({
      budgets: { perCase: 1000, perScan: 50 },
      workers: workers(log),
      now: () => NOW,
    });
    const plan = PlanSchema.parse({
      caseId: CASE,
      budget: { credits: 1000 },
      tasks: [
        acceptProposal(proposal('crawl'), { caseId: CASE, id: 'a', now: NOW }),
        acceptProposal(proposal('draft'), { caseId: CASE, id: 'b', now: NOW }),
        acceptProposal(proposal('verify_claims'), { caseId: CASE, id: 'c', now: NOW }),
      ],
    });
    const report = await d.run(plan, 'scan-1');
    expect(log).toEqual(['a']);
    expect(report.stoppedBecause).toBe('scan_budget');
    expect(report.tasks.map((t) => [t.id, t.status, t.reason ?? ''])).toEqual([
      ['a', 'done', ''],
      ['b', 'skipped', 'stopped: scan_budget'],
      ['c', 'skipped', 'stopped: scan_budget'],
    ]);
    expect(report.spentThisScan).toBe(40);
  });

  it('stops at the case budget across scans', async () => {
    const log: string[] = [];
    const d = new Dispatcher({
      budgets: { perCase: 45, perScan: 45 },
      workers: workers(log),
      now: () => NOW,
    });
    await d.run(d.plan(CASE, [{ proposal: proposal('crawl') }]), 'scan-1');
    expect(d.remainingForCase(CASE)).toBe(5);
    expect(() => d.plan(CASE, [{ proposal: proposal('draft') }])).toThrow(
      /against 5 available for the case/,
    );
    const plan = PlanSchema.parse({
      caseId: CASE,
      budget: { credits: 45 },
      tasks: [
        acceptProposal(proposal('verify_claims'), { caseId: CASE, id: 'v', now: NOW }),
        acceptProposal(proposal('draft'), { caseId: CASE, id: 'd', now: NOW }),
      ],
    });
    const report = await d.run(plan, 'scan-2');
    expect(report.tasks.map((t) => [t.id, t.status])).toEqual([
      ['v', 'done'],
      ['d', 'skipped'],
    ]);
    expect(report.stoppedBecause).toBe('case_budget');
    expect(report.spentOnCase).toBe(42);
    // Another case is unaffected.
    expect(d.remainingForCase('DE-26-AAAA')).toBe(45);
  });

  it('a cycle is refused, and a missing worker skips the task rather than crashing the run', async () => {
    const a = acceptProposal(proposal('draft'), {
      caseId: CASE,
      id: 'a',
      now: NOW,
      dependsOn: ['b'],
    });
    const b = acceptProposal(proposal('draft'), {
      caseId: CASE,
      id: 'b',
      now: NOW,
      dependsOn: ['a'],
    });
    expect(() => topological([a, b])).toThrow(/cycle/);
    const d = new Dispatcher({
      budgets: { perCase: 100, perScan: 100 },
      workers: {},
      now: () => NOW,
    });
    const report = await d.run(d.plan(CASE, [{ proposal: proposal('draft') }]), 'scan-1');
    expect(report.tasks[0]).toMatchObject({ status: 'skipped', reason: 'no worker for draft' });
    expect(report.spentThisScan).toBe(0);
  });
});
