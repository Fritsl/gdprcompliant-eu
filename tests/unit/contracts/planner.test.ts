import { describe, expect, it } from 'vitest';
import {
  PlanSchema,
  PlannerTaskSchema,
  TASK_PAYLOADS,
  TASK_TYPES,
  TaskProposalSchema,
  TaskResultSchema,
} from '@gc/contracts';
import { CASE_ID, NOW } from './helpers.js';

const crawl = {
  id: 't-1',
  caseId: CASE_ID,
  type: 'crawl',
  payload: { url: 'https://eksempelbutik.dk/', depth: 1, passes: ['A', 'B', 'C'] },
  cost: { credits: 5 },
  createdAt: NOW,
};

describe('PlannerTask (A-04)', () => {
  it('the catalogue is closed: an unknown type is rejected', () => {
    const r = PlannerTaskSchema.safeParse({ ...crawl, type: 'hack_the_planet', payload: {} });
    expect(r.success).toBe(false);
  });

  it('every type has a payload schema', () => {
    expect(Object.keys(TASK_PAYLOADS).sort()).toEqual([...TASK_TYPES].sort());
  });

  it('a task declares its cost', () => {
    const { cost: _drop, ...noCost } = crawl;
    expect(_drop).toBeDefined();
    expect(PlannerTaskSchema.safeParse(noCost).success).toBe(false);
    expect(PlannerTaskSchema.safeParse(crawl).success).toBe(true);
  });

  it('payloads are checked per type', () => {
    expect(
      PlannerTaskSchema.safeParse({
        ...crawl,
        payload: { url: 'not a url', depth: 1, passes: ['A'] },
      }).success,
    ).toBe(false);
    expect(
      PlannerTaskSchema.safeParse({
        ...crawl,
        type: 'registry_lookup',
        payload: { registry: 'CVR', query: {} },
      }).success,
    ).toBe(false);
    expect(
      PlannerTaskSchema.safeParse({
        ...crawl,
        type: 'registry_lookup',
        payload: { registry: 'CVR', query: { domain: 'eksempelbutik.dk' } },
      }).success,
    ).toBe(true);
  });

  it('a proposal from the model carries no id, cost or status', () => {
    const proposal = {
      type: 'crawl',
      payload: crawl.payload,
      rationale: 'The homepage has not been crawled.',
    };
    expect(TaskProposalSchema.safeParse(proposal).success).toBe(true);
    expect(TaskProposalSchema.safeParse({ ...proposal, cost: { credits: 0 } }).success).toBe(false);
  });
});

describe('Plan', () => {
  it('must fit its budget', () => {
    const plan = {
      caseId: CASE_ID,
      budget: { credits: 8 },
      tasks: [crawl, { ...crawl, id: 't-2' }],
    };
    const r = PlanSchema.safeParse(plan);
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/budget/);
    expect(PlanSchema.safeParse({ ...plan, budget: { credits: 10 } }).success).toBe(true);
  });

  it('dependencies point at tasks in the plan', () => {
    const plan = {
      caseId: CASE_ID,
      budget: { credits: 100 },
      tasks: [{ ...crawl, dependsOn: ['t-404'] }],
    };
    expect(PlanSchema.safeParse(plan).success).toBe(false);
  });
});

describe('TaskResult (A-05)', () => {
  it('returns claims and evidence, never conclusions', () => {
    const r = TaskResultSchema.safeParse({ taskId: 't-1', type: 'crawl', cost: { credits: 4 } });
    expect(r.success).toBe(true);
    expect(r.data?.claims).toEqual([]);
    expect(Object.keys(TaskResultSchema.shape)).not.toContain('findings');
  });
});
