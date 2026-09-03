import { PgBoss, type JobWithMetadata } from 'pg-boss';
import { deadLetterName, type JobDefinition } from './define.js';

// The one job interface the rest of the codebase sees (F-06). pg-boss underneath, on the
// same Postgres; nothing outside this file imports it, so the queue can be swapped
// without touching a worker.
//
// Delivery is at-least-once across a crash: a worker that dies mid-job leaves the job
// active until it expires, and the next worker gets it back with the last checkpoint.
// Handlers are therefore written to resume from `progress`, never to assume a clean
// start, and side effects are keyed so a repeat is a no-op.

export interface JobQueueOptions {
  connectionString: string;
  // pg-boss keeps its tables in its own schema, 'pgboss' by default.
  schema?: string;
  pollingIntervalSeconds?: number;
  // How often abandoned (expired) jobs are released for retry. Production leaves the
  // default; the crash test sets it to one second.
  superviseIntervalSeconds?: number;
}

export interface JobContext<P, S> {
  readonly id: string;
  readonly payload: P;
  // The last checkpoint, if this is a resumed attempt.
  readonly progress: S | undefined;
  // 0 on the first attempt.
  readonly attempt: number;
  readonly signal: AbortSignal;
  checkpoint(progress: S): Promise<void>;
}

export type JobHandler<P, S> = (job: JobContext<P, S>) => Promise<void>;

export type JobState = JobWithMetadata['state'];

export interface JobStatus<P, S> {
  id: string;
  state: JobState;
  payload: P;
  progress: S | undefined;
  attempts: number;
}

export interface DeadLetter<P, S = never> {
  id: string;
  payload: P;
  progress: S | undefined;
  reason: string;
  failedAt: Date;
}

// A thrown error is stored serialised ({ name, message, stack }); an expiry or a
// heartbeat miss as { value: { message } }.
function failureReason(output: unknown): string {
  const o = (output ?? {}) as { message?: unknown; value?: { message?: unknown } };
  if (typeof o.message === 'string') return o.message;
  if (typeof o.value?.message === 'string') return o.value.message;
  return 'no reason recorded';
}

interface Envelope<P, S> {
  payload: P;
  progress?: S;
}

export class JobQueue {
  readonly #boss: PgBoss;
  readonly #schema: string;
  readonly #pollingIntervalSeconds: number;
  readonly #registered = new Set<string>();

  constructor(options: JobQueueOptions) {
    this.#schema = options.schema ?? 'pgboss';
    this.#pollingIntervalSeconds = options.pollingIntervalSeconds ?? 2;
    this.#boss = new PgBoss({
      connectionString: options.connectionString,
      schema: this.#schema,
      max: 4,
      supervise: true,
      superviseIntervalSeconds: options.superviseIntervalSeconds ?? 60,
      monitorIntervalSeconds: options.superviseIntervalSeconds ?? 60,
    });
    this.#boss.on('error', () => {
      // Surfaced through job state, not as a crash of the process holding the pool.
    });
  }

  get schema(): string {
    return this.#schema;
  }

  async start(): Promise<void> {
    await this.#boss.start();
  }

  // graceful: wait for running handlers. Otherwise fail them so they retry at once.
  async stop(options: { graceful?: boolean } = {}): Promise<void> {
    await this.#boss.stop({ graceful: options.graceful ?? true, close: true, timeout: 5_000 });
  }

  // What a crash does: the workers vanish and their jobs stay active in the database,
  // untouched, until they expire and another worker takes them over. For the crash test.
  async abandon(): Promise<void> {
    for (const name of this.#registered) await this.#boss.offWork(name, { wait: false });
  }

  async register<P, S>(job: JobDefinition<P, S>): Promise<void> {
    if (this.#registered.has(job.name)) return;
    await this.#boss.createQueue(deadLetterName(job.name), {
      retryLimit: 0,
      deleteAfterSeconds: 0,
    });
    await this.#boss.createQueue(job.name, {
      retryLimit: job.retryLimit,
      expireInSeconds: job.expireInSeconds,
      deadLetter: deadLetterName(job.name),
    });
    this.#registered.add(job.name);
  }

  // Fails fast: a payload that does not match the schema never reaches the queue.
  async enqueue<P, S>(job: JobDefinition<P, S>, payload: P): Promise<string> {
    const parsed = job.payload.safeParse(payload);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`);
      throw new Error(`${job.name}: payload rejected: ${issues.join('; ')}`);
    }
    await this.register(job);
    const envelope: Envelope<P, S> = { payload: parsed.data };
    const id = await this.#boss.send(job.name, envelope);
    if (!id) throw new Error(`${job.name}: not enqueued`);
    return id;
  }

  async work<P, S>(job: JobDefinition<P, S>, handler: JobHandler<P, S>): Promise<void> {
    await this.register(job);
    await this.#boss.work(
      job.name,
      {
        includeMetadata: true,
        batchSize: 1,
        pollingIntervalSeconds: this.#pollingIntervalSeconds,
      } as const,
      async ([raw]: JobWithMetadata<Envelope<P, S>>[]) => {
        if (!raw) return;
        // A row written around the API still cannot reach a handler unvalidated.
        const payload = job.payload.safeParse(raw.data?.payload);
        if (!payload.success) {
          const issues = payload.error.issues.map((i) => i.message);
          throw new Error(`payload rejected: ${issues.join('; ')}`);
        }
        const progress =
          job.progress && raw.data?.progress !== undefined
            ? job.progress.safeParse(raw.data.progress)
            : undefined;
        await handler({
          id: raw.id,
          payload: payload.data,
          progress: progress?.success ? progress.data : undefined,
          attempt: raw.retryCount,
          signal: raw.signal,
          checkpoint: async (next) => {
            if (!job.progress) throw new Error(`${job.name} declares no progress shape`);
            const envelope: Envelope<P, S> = {
              payload: payload.data,
              progress: job.progress.parse(next),
            };
            // pg-boss's own update() only reaches jobs that are still queued; a checkpoint
            // is by definition on an active one. Its retry path carries `data` across, so
            // the progress written here is what the next attempt receives.
            await this.#boss
              .getDb()
              .executeSql(
                `update "${this.#schema}".job set data = $1::jsonb where name = $2 and id = $3::uuid and state = 'active'`,
                [JSON.stringify(envelope), job.name, raw.id],
              );
          },
        });
      },
    );
  }

  async status<P, S>(job: JobDefinition<P, S>, id: string): Promise<JobStatus<P, S> | undefined> {
    const [found] = await this.#boss.findJobs<Envelope<P, S>>(job.name, { id });
    if (!found) return undefined;
    return {
      id: found.id,
      state: found.state,
      payload: found.data.payload,
      progress: found.data.progress,
      attempts: found.retryCount + 1,
    };
  }

  // Every job that ran out of retries, with the reason it last failed. The dead-letter
  // copy is a new job in its own queue; `payload` and `reason` are what a person needs.
  async deadLetters<P, S>(job: JobDefinition<P, S>): Promise<DeadLetter<P, S>[]> {
    const rows = await this.#boss.findJobs<Envelope<P, S>>(deadLetterName(job.name));
    return rows.map((row) => ({
      id: row.id,
      payload: row.data.payload,
      progress: row.data.progress,
      reason: failureReason(row.output),
      failedAt: row.createdOn,
    }));
  }

  // A cron schedule for a job; the same payload every time. Idempotent per job name.
  async schedule<P, S>(job: JobDefinition<P, S>, cron: string, payload: P): Promise<void> {
    await this.register(job);
    await this.#boss.schedule(job.name, cron, { payload: job.payload.parse(payload) });
  }

  async unschedule<P, S>(job: JobDefinition<P, S>): Promise<void> {
    await this.#boss.unschedule(job.name);
  }

  // Runs the maintenance pass now instead of waiting for the interval.
  async supervise(): Promise<void> {
    await this.#boss.supervise();
  }

  // Test hygiene: remove the schema and everything in it.
  async drop(): Promise<void> {
    await this.#boss.getDb().executeSql(`drop schema if exists "${this.#schema}" cascade`);
  }
}
