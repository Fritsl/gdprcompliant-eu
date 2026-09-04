import {
  TASK_TYPES,
  type ModelInput,
  type Plan,
  type TaskProposal,
  type TaskType,
} from '@gc/contracts';
import { InvalidTaskProposal, TASK_CATALOGUE, UnknownTaskType, costOf } from './catalogue.js';
import { BudgetExceeded, Dispatcher } from './dispatcher.js';
import { ModelClient, ModelOutputError } from './model-client.js';

// The planner (A-06): what to do next on a case, as tasks from the closed catalogue,
// within the budget, each with a line that says why. Two planners agree on the shape:
// the heuristic one is a fixed sequence over the case's state and needs no model; the
// model one proposes and is held to the same catalogue, guards and budget, retried
// once on a malformed answer and then escalated, with the heuristic plan standing in
// so the case never waits on the model being good. Given the same input and seed, the
// plan is the same: the heuristic by construction, the model by seed and cassette.

export type PlannerInput = ModelInput<'plan_tasks'>;

export interface Rationale {
  readonly type: TaskType;
  readonly rationale: string;
}

export type PlanSource = 'heuristic' | 'model';

export interface PlanOutcome {
  readonly plan: Plan;
  readonly source: PlanSource;
  readonly rationales: readonly Rationale[];
  // Set when the model's answer was rejected twice and a person should look.
  readonly escalated?: string;
}

const PROPOSED_QUESTIONS: Record<string, string> = {
  'TRF-01': 'What must be in place before personal data is sent to a recipient outside the EEA?',
  'POL-01': 'What must a privacy notice tell a person at the time their data is collected?',
  'CNS-01': 'When may a website set cookies or run a tracker before the visitor has agreed?',
  'DPA-01': 'What must a contract with a processor contain?',
  'FRM-03': 'What must be said at the point where a form collects personal data?',
};

const CONTRACT_QUESTIONS = [
  'Who is the processor and who is the controller?',
  'What is the subject-matter, duration, nature and purpose of the processing?',
  'Which sub-processors are named, and how is a new one announced?',
];

// The fixed sequence: read the site, resolve who it talks to, read what the case holds,
// look up the law behind the worst open duty, draft when the register is confirmed,
// verify what the workers claimed. Each step only when its precondition holds and its
// price fits.
export function heuristicProposals(input: PlannerInput): TaskProposal[] {
  const state = input.state ?? {};
  const available = new Set(input.availableTypes);
  const open = new Set(input.openFindingTypeIds);
  const applies = new Set(
    (input.duties ?? [])
      .filter((d) => d.status === 'applies')
      .flatMap((d) => d.findingTypeIds ?? []),
  );
  const out: TaskProposal[] = [];
  const url = `https://${input.case.company.domain}/`;
  if (available.has('crawl') && !state.scanned) {
    out.push({
      type: 'crawl',
      payload: { url, depth: 0, passes: ['A', 'B'] },
      rationale:
        'Nothing has been read from the site yet, so the first load and the refusal come first.',
    });
  }
  if (available.has('registry_lookup') && (state.unresolvedVendors ?? 0) > 0) {
    out.push({
      type: 'registry_lookup',
      payload: { registry: 'cvr', query: { domain: input.case.company.domain } },
      rationale: `${state.unresolvedVendors} recipient(s) could not be named, so the register is asked who is behind the site.`,
    });
  }
  const contract = state.documentEvidenceIds?.[0];
  if (
    available.has('read_contract') &&
    contract &&
    (open.has('DPA-01') || open.has('SUB-03') || applies.has('DPA-01'))
  ) {
    out.push({
      type: 'read_contract',
      payload: { documentEvidenceId: contract, questions: CONTRACT_QUESTIONS },
      rationale:
        'A processing agreement is on the case and a contract duty is open, so it is read for what it settles.',
    });
  }
  const worst =
    [...open].find((t) => PROPOSED_QUESTIONS[t]) ?? [...applies].find((t) => PROPOSED_QUESTIONS[t]);
  if (available.has('research') && worst) {
    out.push({
      type: 'research',
      payload: {
        question: PROPOSED_QUESTIONS[worst]!,
        jurisdiction: input.case.jurisdiction,
        maxPassages: 5,
      },
      rationale: `${worst} is open, so the passages behind it are fetched for the explanation and the draft.`,
    });
  }
  if (
    available.has('draft') &&
    (open.has('POL-01') || applies.has('POL-01')) &&
    (state.registerConfirmed ?? 0) > 0 &&
    !state.policyPublished
  ) {
    out.push({
      type: 'draft',
      payload: {
        artefact: 'privacy_policy',
        locale: input.case.locale,
        inputs: { evidence: [], questionIds: [] },
      },
      rationale: `${state.registerConfirmed} register row(s) are confirmed and no policy is published, so the draft is written from them.`,
    });
  }
  if (available.has('verify_claims') && (state.unverifiedClaimIds?.length ?? 0) > 0) {
    out.push({
      type: 'verify_claims',
      payload: { claimIds: [...state.unverifiedClaimIds!] },
      rationale: `${state.unverifiedClaimIds!.length} claim(s) from the workers wait for the verifier before anything rests on them.`,
    });
  }
  // Within budget, in order; the first that does not fit ends the plan.
  const fitted: TaskProposal[] = [];
  let spent = 0;
  for (const p of out) {
    const price = costOf(p).credits;
    if (spent + price > input.budget.credits) break;
    spent += price;
    fitted.push(p);
  }
  return fitted;
}

// Dependencies by position: everything after a crawl waits for it; verification waits
// for whatever came before it.
export function dependencies(proposals: readonly TaskProposal[]): number[][] {
  const crawlAt = proposals.findIndex((p) => p.type === 'crawl');
  return proposals.map((p, i) => {
    if (p.type === 'crawl') return [];
    if (p.type === 'verify_claims') return proposals.slice(0, i).map((_, j) => j);
    return crawlAt >= 0 && crawlAt < i ? [crawlAt] : [];
  });
}

export const PLANNER_SYSTEM_PROMPT = [
  'You plan the next work on one compliance case for a small company’s website.',
  'Choose tasks only from the task types offered, with the payload shapes described, and stay within the budget.',
  'Prefer the smallest set that moves the case: read the site before anything else if it has not been read;',
  'resolve unknown recipients before drafting; draft documents only from a confirmed register;',
  'verify claims before anything rests on them. Never widen the scope beyond the company’s own domain.',
  'For each task write one plain sentence of rationale a person can read on the case page.',
  'Answer as JSON: {"tasks": [{"type", "payload", "rationale"}]}.',
].join(' ');

const describePayloads = (types: readonly TaskType[]): string =>
  types
    .map((t) => {
      switch (t) {
        case 'crawl':
          return 'crawl: {url (the company site), depth 0-3, passes ["A","B","C"] subset}';
        case 'read_contract':
          return 'read_contract: {documentEvidenceId (a stored document id), questions [strings]}';
        case 'registry_lookup':
          return 'registry_lookup: {registry (e.g. "cvr"), query {domain | name | registryId}}';
        case 'research':
          return 'research: {question, jurisdiction (the case’s), maxPassages 1-20}';
        case 'draft':
          return 'draft: {artefact (privacy_policy | cookie_declaration | ...), locale (the case’s), inputs {evidence [], questionIds []}}';
        case 'verify_claims':
          return 'verify_claims: {claimIds [ids of unverified claims]}';
      }
    })
    .join('\n');

export function plannerPrompt(input: PlannerInput): { system: string; user: string } {
  const state = input.state ?? {};
  const lines: string[] = [];
  lines.push(
    `Case ${input.case.id}: ${input.case.company.domain}, jurisdiction ${input.case.jurisdiction}, language ${input.case.locale}, stage ${input.case.stage}.`,
  );
  lines.push(
    `Open finding types: ${input.openFindingTypeIds.length > 0 ? input.openFindingTypeIds.join(', ') : 'none'}.`,
  );
  const duties = (input.duties ?? []).filter((d) => d.status === 'applies');
  lines.push(
    `Duties that apply: ${duties.length > 0 ? duties.map((d) => `${d.ruleId} (${d.title})`).join('; ') : 'none evaluated'}.`,
  );
  lines.push(
    `State: site ${state.scanned ? 'read' : 'not read yet'}; register ${state.registerRows ?? 0} row(s), ${state.registerConfirmed ?? 0} confirmed; ${state.unresolvedVendors ?? 0} unresolved recipient(s); ${state.documentEvidenceIds?.length ?? 0} stored document(s)${state.documentEvidenceIds?.length ? ` (${state.documentEvidenceIds.join(', ')})` : ''}; ${state.unverifiedClaimIds?.length ?? 0} unverified claim(s)${state.unverifiedClaimIds?.length ? ` (${state.unverifiedClaimIds.join(', ')})` : ''}; policy ${state.policyPublished ? 'published' : 'not published'}.`,
  );
  lines.push(
    `Budget: ${input.budget.credits} credits. Costs: crawl 10 per pass per depth level, read_contract 5 plus 1 per question, registry_lookup 2, research 3 plus 1 per passage, draft 15, verify_claims 1 per claim.`,
  );
  lines.push('Task types available, with their payloads:');
  lines.push(describePayloads(input.availableTypes));
  return { system: PLANNER_SYSTEM_PROMPT, user: lines.join('\n') };
}

export interface PlannerDeps {
  readonly dispatcher: Dispatcher;
  // Absent in a configuration without a model: the heuristic plans alone.
  readonly model?: ModelClient;
  readonly seed?: number;
  // A person is told when the model's plan was rejected twice.
  readonly escalate?: (reason: string) => void;
}

function accept(
  dispatcher: Dispatcher,
  input: PlannerInput,
  proposals: readonly TaskProposal[],
): Plan {
  // The planner's own budget first; the dispatcher's case and scan budgets after.
  const total = proposals.reduce((n, p) => n + costOf(p).credits, 0);
  if (total > input.budget.credits) throw new BudgetExceeded('scan', total, input.budget.credits);
  const caseId = input.case.id;
  const deps = dependencies(proposals);
  return dispatcher.plan(
    caseId,
    proposals.map((proposal, i) => ({ proposal, dependsOn: deps[i]! })),
  );
}

// The plan for the case: the model's when it answers well, the heuristic's otherwise,
// and always one that the dispatcher accepted.
export async function plan(input: PlannerInput, deps: PlannerDeps): Promise<PlanOutcome> {
  const heuristic = heuristicProposals(input);
  const fallback = (): PlanOutcome => ({
    plan: accept(deps.dispatcher, input, heuristic),
    source: 'heuristic',
    rationales: heuristic.map((p) => ({ type: p.type, rationale: p.rationale })),
  });
  if (!deps.model) return fallback();
  const prompt = plannerPrompt(input);
  let proposals: TaskProposal[];
  try {
    const out = await deps.model.call({
      name: 'plan_tasks',
      input,
      system: prompt.system,
      user: prompt.user,
      ...(deps.seed !== undefined ? { seed: deps.seed } : {}),
    });
    proposals = out.tasks;
  } catch (e) {
    if (e instanceof ModelOutputError) {
      const reason = `the model's plan was rejected twice: ${e.message}`;
      deps.escalate?.(reason);
      return { ...fallback(), escalated: reason };
    }
    throw e;
  }
  try {
    const accepted = accept(deps.dispatcher, input, proposals);
    return {
      plan: accepted,
      source: 'model',
      rationales: proposals.map((p) => ({ type: p.type, rationale: p.rationale })),
    };
  } catch (e) {
    if (
      e instanceof BudgetExceeded ||
      e instanceof InvalidTaskProposal ||
      e instanceof UnknownTaskType
    ) {
      const reason = `the model's plan was rejected by the dispatcher: ${(e as Error).message}`;
      deps.escalate?.(reason);
      return { ...fallback(), escalated: reason };
    }
    throw e;
  }
}

export const PLANNABLE_TYPES: readonly TaskType[] = TASK_TYPES.filter((t) => t in TASK_CATALOGUE);
