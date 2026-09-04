import { span } from '@gc/telemetry';
import {
  PlanSchema,
  TaskResultSchema,
  type Plan,
  type PlannerTask,
  type TaskCost,
  type TaskResult,
  type TaskStatus,
  type TaskType,
} from '@gc/contracts';
import { TASK_CATALOGUE, UnknownTaskType, acceptProposal, specFor } from './catalogue.js';

// The dispatcher (A-04): turns proposals into a plan that fits the case's remaining
// budget, runs the plan in dependency order through typed workers, validates what each
// worker returns against the catalogue, and stops the moment the next task would
// overspend the scan or the case. Stopping is a result, not an exception: the report
// says which tasks ran, which were skipped, and why.

export interface Budgets {
  // Credits a case may spend over its whole life.
  readonly perCase: number;
  // Credits one scan (one run of a plan) may spend.
  readonly perScan: number;
}

export interface TaskOutcome {
  readonly result: TaskResult;
  // The type-specific output, validated against the catalogue's schema.
  readonly output: unknown;
}

export type Worker<T extends TaskType = TaskType> = (
  task: Extract<PlannerTask, { type: T }>,
) => Promise<TaskOutcome>;

export type Workers = { readonly [T in TaskType]?: Worker<T> };

export interface DispatchedTask {
  readonly id: string;
  readonly type: TaskType;
  readonly status: TaskStatus;
  readonly attempts: number;
  readonly cost: TaskCost;
  readonly reason?: string;
  readonly output?: unknown;
  readonly result?: TaskResult;
}

export interface DispatchReport {
  readonly caseId: string;
  readonly scanId: string;
  readonly budget: Budgets;
  readonly spentThisScan: number;
  readonly spentOnCase: number;
  readonly tasks: readonly DispatchedTask[];
  readonly stoppedBecause?: 'scan_budget' | 'case_budget';
}

export class BudgetExceeded extends Error {
  constructor(
    readonly scope: 'case' | 'scan',
    readonly asked: number,
    readonly available: number,
  ) {
    super(`plan costs ${asked} credits against ${available} available for the ${scope}`);
    this.name = 'BudgetExceeded';
  }
}

export interface DispatcherOptions {
  readonly budgets: Budgets;
  readonly workers: Workers;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

// Case spend is remembered across scans; a case that used its budget last week has
// none left this week until someone raises it.
export class Dispatcher {
  readonly #budgets: Budgets;
  readonly #workers: Workers;
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #spent = new Map<string, number>();

  constructor(options: DispatcherOptions) {
    this.#budgets = options.budgets;
    this.#workers = options.workers;
    this.#now = options.now ?? (() => new Date());
    let n = 0;
    this.#newId = options.newId ?? (() => `task-${++n}`);
  }

  spentOnCase(caseId: string): number {
    return this.#spent.get(caseId) ?? 0;
  }

  remainingForCase(caseId: string): number {
    return Math.max(0, this.#budgets.perCase - this.spentOnCase(caseId));
  }

  // Proposals in, a plan out, or a loud refusal: an unknown type, a bad payload, or a
  // total the case cannot afford. Dependencies are by position: `dependsOn` names
  // earlier proposals in the same list by index.
  plan(
    caseId: string,
    proposals: readonly { proposal: unknown; dependsOn?: readonly number[] }[],
  ): Plan {
    const ids: string[] = [];
    const tasks: PlannerTask[] = proposals.map((p, i) => {
      const id = this.#newId();
      ids.push(id);
      const dependsOn = (p.dependsOn ?? []).map((j) => {
        const dep = ids[j];
        if (j >= i || dep === undefined)
          throw new Error(`proposal ${i} depends on ${j}, which is not before it`);
        return dep;
      });
      return acceptProposal(p.proposal, { caseId, id, now: this.#now(), dependsOn });
    });
    const total = tasks.reduce((sum, t) => sum + t.cost.credits, 0);
    const available = Math.min(this.remainingForCase(caseId), this.#budgets.perScan);
    if (total > available) {
      throw new BudgetExceeded(
        this.remainingForCase(caseId) < this.#budgets.perScan ? 'case' : 'scan',
        total,
        available,
      );
    }
    return PlanSchema.parse({ caseId, budget: { credits: available }, tasks });
  }

  // Runs a plan. Order is dependency order; a task whose dependency did not finish is
  // skipped; a retryable failure is retried up to the catalogue's limit, each attempt
  // paid for; and before every attempt the budgets are checked against actual spend.
  async run(plan: Plan, scanId: string): Promise<DispatchReport> {
    const validated = PlanSchema.parse(plan);
    const done = new Map<string, DispatchedTask>();
    let spentThisScan = 0;
    let stoppedBecause: DispatchReport['stoppedBecause'];

    const order = topological(validated.tasks);
    for (const task of order) {
      if (stoppedBecause) {
        done.set(task.id, skipped(task, `stopped: ${stoppedBecause}`));
        continue;
      }
      const blocked = task.dependsOn.find((d) => done.get(d)?.status !== 'done');
      if (blocked) {
        done.set(task.id, skipped(task, `depends on ${blocked}, which did not finish`));
        continue;
      }
      const spec = specFor(task.type);
      const worker = this.#workers[task.type] as Worker | undefined;
      if (!worker) {
        done.set(task.id, skipped(task, `no worker for ${task.type}`));
        continue;
      }

      let attempts = 0;
      let last: DispatchedTask | undefined;
      while (attempts < spec.maxAttempts) {
        const price = task.cost.credits;
        if (spentThisScan + price > this.#budgets.perScan) {
          stoppedBecause = 'scan_budget';
          break;
        }
        if (this.spentOnCase(validated.caseId) + price > this.#budgets.perCase) {
          stoppedBecause = 'case_budget';
          break;
        }
        attempts += 1;
        // Paid before it runs: a worker that dies still spent its budget.
        spentThisScan += price;
        this.#spent.set(validated.caseId, this.spentOnCase(validated.caseId) + price);
        last = await span(
          'agent.task',
          {
            taskType: task.type,
            taskId: task.id,
            scanId,
            credits: task.cost.credits,
            attempt: attempts,
          },
          () => this.#attempt(task, spec.output, worker, attempts),
          { traceId: scanId },
        );
        if (last.status === 'done' || !last.reason?.startsWith('retryable:')) break;
      }
      done.set(task.id, last ?? skipped(task, `stopped: ${stoppedBecause ?? 'budget'}`));
      if (stoppedBecause && !last) {
        done.set(task.id, skipped(task, `stopped: ${stoppedBecause}`));
      }
    }

    return {
      caseId: validated.caseId,
      scanId,
      budget: this.#budgets,
      spentThisScan,
      spentOnCase: this.spentOnCase(validated.caseId),
      tasks: validated.tasks.map((t) => done.get(t.id) ?? skipped(t, 'never reached')),
      ...(stoppedBecause ? { stoppedBecause } : {}),
    };
  }

  async #attempt(
    task: PlannerTask,
    output: TaskSpecOutput,
    worker: Worker,
    attempts: number,
  ): Promise<DispatchedTask> {
    let outcome: TaskOutcome;
    try {
      outcome = await worker(task as never);
    } catch (e) {
      return {
        id: task.id,
        type: task.type,
        status: 'failed',
        attempts,
        cost: task.cost,
        reason: `retryable: worker threw: ${(e as Error).message}`,
      };
    }
    const result = TaskResultSchema.safeParse(outcome.result);
    if (!result.success || result.data.taskId !== task.id || result.data.type !== task.type) {
      return {
        id: task.id,
        type: task.type,
        status: 'failed',
        attempts,
        cost: task.cost,
        reason: 'result rejected: not a TaskResult for this task',
      };
    }
    if (result.data.failure) {
      return {
        id: task.id,
        type: task.type,
        status: 'failed',
        attempts,
        cost: result.data.cost,
        reason: `${result.data.failure.retryable ? 'retryable' : 'final'}: ${result.data.failure.reason}`,
        result: result.data,
      };
    }
    const parsed = output.safeParse(outcome.output);
    if (!parsed.success) {
      return {
        id: task.id,
        type: task.type,
        status: 'failed',
        attempts,
        cost: result.data.cost,
        reason: `output rejected: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`,
        result: result.data,
      };
    }
    return {
      id: task.id,
      type: task.type,
      status: 'done',
      attempts,
      cost: result.data.cost,
      output: parsed.data,
      result: result.data,
    };
  }
}

type TaskSpecOutput = (typeof TASK_CATALOGUE)[TaskType]['output'];

const skipped = (task: PlannerTask, reason: string): DispatchedTask => ({
  id: task.id,
  type: task.type,
  status: 'skipped',
  attempts: 0,
  cost: { credits: 0 },
  reason,
});

// Kahn's algorithm over dependsOn, keeping plan order among the ready tasks. A cycle
// cannot get past PlanSchema's unknown-dependency check only if it is self-contained,
// so it is caught here and refused.
export function topological(tasks: readonly PlannerTask[]): PlannerTask[] {
  const remaining = new Map(tasks.map((t) => [t.id, t]));
  const out: PlannerTask[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.values()].filter((t) =>
      t.dependsOn.every((d) => !remaining.has(d)),
    );
    if (ready.length === 0) {
      throw new Error(`tasks depend on each other in a cycle: ${[...remaining.keys()].join(', ')}`);
    }
    for (const t of ready) {
      out.push(t);
      remaining.delete(t.id);
    }
  }
  return out;
}

export { UnknownTaskType };
