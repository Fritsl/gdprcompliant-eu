import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  Dispatcher,
  ModelClient,
  TASK_CATALOGUE,
  dependencies,
  heuristicProposals,
  plan,
  plannerPrompt,
  type PlannerInput,
} from '@gc/agent';
import { loadConfig } from '@gc/config';
import { PlanSchema, TASK_TYPES, type Case, type TaskType } from '@gc/contracts';
import { bannedClaims, loadClaimVocabulary } from '@gc/i18n';

// The planner (A-06): twenty fixed scenarios and the task a sensible planner picks
// first; the heuristic must agree on at least 90% and the model, when configured, too.
// Nothing outside the catalogue gets through; a malformed answer is retried once and
// then escalated, with the heuristic plan standing in; every task carries a line of
// rationale; and the same input with the same seed gives the same plan.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
interface Scenario {
  readonly name: string;
  readonly open: string[];
  readonly duties?: NonNullable<PlannerInput['duties']>;
  readonly state: NonNullable<PlannerInput['state']>;
  readonly budget?: number;
  readonly available?: TaskType[];
  readonly jurisdiction?: 'DK' | 'DE';
  readonly locale?: 'da' | 'de';
  readonly acceptable: TaskType[];
  readonly anyOrNone?: boolean;
}
const fixture = JSON.parse(
  readFileSync(join(ROOT, 'fixtures', 'planner', 'scenarios.json'), 'utf8'),
) as {
  case: Case;
  scenarios: Scenario[];
};
const vocab = loadClaimVocabulary();
const NOW = () => new Date('2026-09-04T09:14:00Z');

const inputOf = (s: Scenario): PlannerInput => ({
  case: {
    ...fixture.case,
    ...(s.jurisdiction ? { jurisdiction: s.jurisdiction } : {}),
    ...(s.locale ? { locale: s.locale } : {}),
    ...(s.jurisdiction ? { company: { ...fixture.case.company, country: s.jurisdiction } } : {}),
  },
  openFindingTypeIds: s.open,
  duties: s.duties ?? [],
  budget: { credits: s.budget ?? 200 },
  availableTypes: s.available ?? [...TASK_TYPES],
  state: s.state,
});

const dispatcher = () => {
  let n = 0;
  return new Dispatcher({
    budgets: { perCase: 10_000, perScan: 1_000 },
    workers: {},
    now: NOW,
    newId: () => `task-${++n}`,
  });
};

const config = loadConfig(
  {
    NODE_ENV: 'test',
    APP_BASE_URL: 'https://gdprcompliant.eu',
    DATABASE_URL: 'postgres://gc:gc@localhost:5432/gc',
    MODEL_BASE_URL: process.env['MODEL_BASE_URL'] ?? 'https://llm.example.eu/v1',
    MODEL_API_KEY: process.env['MODEL_API_KEY'] ?? 'sk-test',
    MODEL_CHAT: process.env['MODEL_CHAT'] ?? 'chat-model',
    MODEL_EMBEDDING: process.env['MODEL_EMBEDDING'] ?? 'embed-model',
  },
  { endpoints: [{ host: 'llm.example.eu', purpose: 'model', jurisdiction: 'DK' }] },
);
const modelConfigured = Boolean(process.env['MODEL_BASE_URL'] && process.env['MODEL_CHAT']);

// A model that answers with the given JSON bodies, in order, then repeats the last.
function scriptedModel(bodies: unknown[]) {
  let i = 0;
  const impl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
    const body = bodies[Math.min(i, bodies.length - 1)];
    i += 1;
    void init;
    return new Response(
      JSON.stringify({
        choices: [
          { message: { role: 'assistant', content: JSON.stringify(body) }, finish_reason: 'stop' },
        ],
      }),
      { status: 200 },
    );
  });
  return { client: new ModelClient(config, { fetch: impl }), impl };
}

const agreement = (
  first: (s: Scenario) => TaskType | undefined,
): { agreed: number; misses: string[] } => {
  let agreed = 0;
  const misses: string[] = [];
  for (const s of fixture.scenarios) {
    const picked = first(s);
    const ok =
      picked === undefined
        ? s.anyOrNone === true || s.acceptable.length === 0
        : s.acceptable.includes(picked) || s.anyOrNone === true;
    if (ok) agreed += 1;
    else
      misses.push(
        `${s.name}: picked ${picked ?? 'nothing'}, acceptable ${s.acceptable.join('|') || 'nothing'}`,
      );
  }
  return { agreed, misses };
};

describe('the scenarios', () => {
  it('are twenty, each with a state and what a sensible planner picks', () => {
    expect(fixture.scenarios).toHaveLength(20);
    for (const s of fixture.scenarios) {
      expect(s.name.length).toBeGreaterThan(5);
      for (const t of s.acceptable) expect(TASK_TYPES).toContain(t);
    }
  });
});

describe('the heuristic planner', () => {
  it('picks a sensible next task on at least 90% of the scenarios', () => {
    const { agreed, misses } = agreement((s) => heuristicProposals(inputOf(s))[0]?.type);
    if (misses.length > 0) console.log('heuristic misses', misses);
    expect(agreed / fixture.scenarios.length).toBeGreaterThanOrEqual(0.9);
  });

  it('stays within the catalogue and the budget, and the dispatcher accepts every plan', async () => {
    for (const s of fixture.scenarios) {
      const input = inputOf(s);
      const proposals = heuristicProposals(input);
      const total = proposals.reduce(
        (n, p) => n + TASK_CATALOGUE[p.type].cost(p.payload as never).credits,
        0,
      );
      expect(total, s.name).toBeLessThanOrEqual(input.budget.credits);
      for (const p of proposals) expect(input.availableTypes, s.name).toContain(p.type);
      const outcome = await plan(input, { dispatcher: dispatcher() });
      expect(outcome.source).toBe('heuristic');
      expect(PlanSchema.safeParse(outcome.plan).success, s.name).toBe(true);
      expect(outcome.plan.tasks.length).toBe(proposals.length);
    }
  });

  it('explains every task in one plain sentence, without a verdict', () => {
    for (const s of fixture.scenarios) {
      for (const r of heuristicProposals(inputOf(s))) {
        expect(r.rationale.length).toBeGreaterThan(20);
        expect(r.rationale.length).toBeLessThan(200);
        expect(r.rationale.trim().endsWith('.')).toBe(true);
        expect(bannedClaims(r.rationale, 'en', vocab)).toEqual([]);
      }
    }
    // The rationale rides on the accepted task, where the case page reads it.
    const input = inputOf(fixture.scenarios[0]!);
    const outcome = heuristicProposals(input);
    expect(outcome[0]!.rationale).toContain('first load');
  });

  it('orders the work: everything after a crawl waits for it, verification waits for all', () => {
    const input = inputOf(fixture.scenarios[19]!);
    const proposals = heuristicProposals({ ...input, state: { ...input.state, scanned: false } });
    const deps = dependencies(proposals);
    expect(proposals[0]!.type).toBe('crawl');
    for (let i = 1; i < proposals.length; i += 1) {
      if (proposals[i]!.type === 'verify_claims')
        expect(deps[i]).toEqual(proposals.slice(0, i).map((_, j) => j));
      else expect(deps[i]).toEqual([0]);
    }
  });

  it('is reproducible: the same input gives the same plan, twice', async () => {
    const input = inputOf(fixture.scenarios[19]!);
    const a = await plan(input, { dispatcher: dispatcher(), seed: 7 });
    const b = await plan(input, { dispatcher: dispatcher(), seed: 7 });
    expect(a).toEqual(b);
  });
});

describe('the model planner, held to the catalogue', () => {
  const input = inputOf(fixture.scenarios[3]!);
  const good = {
    tasks: [
      {
        type: 'research',
        payload: {
          question: 'Which safeguards does a transfer to the United States need?',
          jurisdiction: 'DK',
          maxPassages: 4,
        },
        rationale: 'A transfer finding is open, so the law behind it is fetched first.',
      },
    ],
  };

  it('accepts a well-formed plan, carries the seed to the endpoint, and keeps the rationale', async () => {
    const { client, impl } = scriptedModel([good]);
    const escalate = vi.fn();
    const outcome = await plan(input, {
      dispatcher: dispatcher(),
      model: client,
      seed: 42,
      escalate,
    });
    expect(outcome.source).toBe('model');
    expect(outcome.escalated).toBeUndefined();
    expect(escalate).not.toHaveBeenCalled();
    expect(outcome.plan.tasks.map((t) => t.type)).toEqual(['research']);
    expect(outcome.plan.tasks[0]!.rationale).toBe(good.tasks[0]!.rationale);
    const body = JSON.parse(String(impl.mock.calls[0]![1]?.body ?? '{}')) as { seed?: number };
    expect(body.seed).toBe(42);
    // The prompt says what is open and what is available, and nothing scraped.
    const prompt = plannerPrompt(input);
    expect(prompt.user).toContain('TRF-01');
    expect(prompt.user).toContain('registry_lookup');
    expect(prompt.system).toContain('only from the task types offered');
  });

  it('rejects a type outside the catalogue, retries once, then escalates and the heuristic stands in', async () => {
    const outside = { tasks: [{ type: 'hack_the_planet', payload: {}, rationale: 'no' }] };
    const { client, impl } = scriptedModel([outside, outside]);
    const escalate = vi.fn();
    const outcome = await plan(input, { dispatcher: dispatcher(), model: client, escalate });
    expect(impl).toHaveBeenCalledTimes(2);
    expect(escalate).toHaveBeenCalledTimes(1);
    expect(escalate.mock.calls[0]![0]).toMatch(/rejected twice/);
    expect(outcome.source).toBe('heuristic');
    expect(outcome.escalated).toMatch(/rejected twice/);
    expect(outcome.plan.tasks.map((t) => t.type)).toEqual(
      heuristicProposals(input).map((p) => p.type),
    );
  });

  it('rejects a plan that widens the scope or breaks the budget the same way', async () => {
    const wide = {
      tasks: [
        {
          type: 'crawl',
          payload: { url: 'https://competitor.example/', depth: 0, passes: ['A'] },
          rationale: 'Look elsewhere.',
        },
      ],
    };
    const { client } = scriptedModel([wide, wide]);
    const escalate = vi.fn();
    const outcome = await plan(input, { dispatcher: dispatcher(), model: client, escalate });
    expect(escalate).toHaveBeenCalledTimes(1);
    expect(outcome.source).toBe('heuristic');
    const tooDear = {
      tasks: [
        {
          type: 'crawl',
          payload: { url: 'https://eksempelbutik.dk/', depth: 3, passes: ['A', 'B', 'C'] },
          rationale: 'Read everything.',
        },
      ],
    };
    const { client: dear } = scriptedModel([tooDear, tooDear]);
    const escalate2 = vi.fn();
    const outcome2 = await plan(
      { ...input, budget: { credits: 30 } },
      { dispatcher: dispatcher(), model: dear, escalate: escalate2 },
    );
    expect(escalate2.mock.calls[0]![0]).toMatch(/dispatcher|budget/i);
    expect(outcome2.source).toBe('heuristic');
  });

  it('recovers when the second answer is good', async () => {
    const outside = { tasks: [{ type: 'hack_the_planet', payload: {}, rationale: 'no' }] };
    const { client, impl } = scriptedModel([outside, good]);
    const escalate = vi.fn();
    const outcome = await plan(input, { dispatcher: dispatcher(), model: client, escalate });
    expect(impl).toHaveBeenCalledTimes(2);
    expect(escalate).not.toHaveBeenCalled();
    expect(outcome.source).toBe('model');
  });
});

describe.skipIf(!modelConfigured)('the model, measured', () => {
  it('picks a sensible next task on at least 90% of the scenarios', async () => {
    const client = new ModelClient(config);
    const picks = new Map<string, TaskType | undefined>();
    for (const s of fixture.scenarios) {
      const outcome = await plan(inputOf(s), { dispatcher: dispatcher(), model: client, seed: 1 });
      picks.set(s.name, outcome.source === 'model' ? outcome.plan.tasks[0]?.type : undefined);
    }
    const { agreed, misses } = agreement((s) => picks.get(s.name));
    console.log(`model agreement ${agreed}/${fixture.scenarios.length}`, misses);
    expect(agreed / fixture.scenarios.length).toBeGreaterThanOrEqual(0.9);
  }, 600_000);
});

if (!modelConfigured) {
  it.skip('the model, measured: set MODEL_BASE_URL and MODEL_CHAT to run', () => {});
}
