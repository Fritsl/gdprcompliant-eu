import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { testDatabaseUrl } from '@gc/db';
import { JobQueue, defineJob } from '@gc/jobs';

// The durable queue (F-06): a malformed payload never gets in, a worker that dies mid-job
// is taken over from its last checkpoint and the job completes exactly once, and a job
// that keeps failing lands in the dead-letter queue with the reason on it.

const url = (() => {
  try {
    return testDatabaseUrl();
  } catch (e) {
    if (process.env['CI']) throw e;
    console.warn((e as Error).message);
    return undefined;
  }
})();

const scan = defineJob({
  name: 'scan-pages',
  payload: z.object({
    caseId: z.string().regex(/^[A-Z]{2}-\d{2}-[A-Z0-9]{4}$/),
    pages: z.int().min(1),
  }),
  progress: z.object({ done: z.int().min(0) }),
  retryLimit: 2,
  // A worker that has not finished in a second is presumed dead. Production uses minutes.
  expireInSeconds: 1,
});

const flaky = defineJob({
  name: 'always-fails',
  payload: z.object({ why: z.string() }),
  retryLimit: 1,
  expireInSeconds: 5,
});

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > deadline) throw new Error(`gave up waiting: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

const hang = () => new Promise<void>(() => {});

describe.skipIf(!url)('durable job queue (F-06)', () => {
  const schema = `pgboss_${randomBytes(4).toString('hex')}`;
  const options = {
    connectionString: url!,
    schema,
    pollingIntervalSeconds: 0.5,
    superviseIntervalSeconds: 1,
  };
  const first = new JobQueue(options);
  const second = new JobQueue(options);

  beforeAll(async () => {
    await first.start();
    await second.start();
  });

  afterAll(async () => {
    await second.stop({ graceful: false });
    await first.drop();
    await first.stop({ graceful: false });
  });

  it('a malformed payload fails fast, before it reaches the queue', async () => {
    const probe = defineJob({ name: 'probe', payload: scan.payload });
    await expect(first.enqueue(probe, { caseId: 'nope', pages: 0 } as never)).rejects.toThrow(
      /probe: payload rejected: caseId .*; pages /,
    );
    const id = await first.enqueue(probe, { caseId: 'DK-26-AAAA', pages: 3, extra: true } as never);
    expect((await first.status(probe, id))?.payload).toEqual({ caseId: 'DK-26-AAAA', pages: 3 });
    expect(() => defineJob({ name: 'Not A Name', payload: z.object({}) })).toThrow(
      /not a job name/,
    );
  });

  it('a killed worker is taken over from its checkpoint and the job completes exactly once', async () => {
    const steps: [string, number][] = [];
    let completed = 0;

    // The first worker checkpoints after two pages and then dies (never returns, never
    // fails, never acknowledges): the process is gone as far as the queue can tell.
    await first.work(scan, async (job) => {
      const from = job.progress?.done ?? 0;
      for (let page = from; page < job.payload.pages; page += 1) {
        steps.push(['first', page]);
        if (page === 1) {
          await job.checkpoint({ done: 2 });
          await first.abandon();
          await hang();
        }
      }
      completed += 1;
    });

    const id = await first.enqueue(scan, { caseId: 'DK-26-AAAA', pages: 5 });
    await until(
      () => first.status(scan, id),
      (s) => s?.progress?.done === 2,
    );
    expect(steps).toEqual([
      ['first', 0],
      ['first', 1],
    ]);

    // The restarted worker: same handler, different process. It gets the job back once
    // it has expired, with the checkpoint, and finishes from page 2.
    await second.work(scan, async (job) => {
      const from = job.progress?.done ?? 0;
      for (let page = from; page < job.payload.pages; page += 1) steps.push(['second', page]);
      completed += 1;
    });
    const done = await until(
      () => second.status(scan, id),
      (s) => s?.state === 'completed',
    );
    expect(done?.attempts).toBe(2);
    expect(steps).toEqual([
      ['first', 0],
      ['first', 1],
      ['second', 2],
      ['second', 3],
      ['second', 4],
    ]);
    await new Promise((r) => setTimeout(r, 1_500));
    expect(completed).toBe(1);
  });

  it('a job that keeps failing lands in the dead-letter queue with its reason', async () => {
    await second.work(flaky, async (job) => {
      throw new Error(`cannot: ${job.payload.why}`);
    });
    const id = await second.enqueue(flaky, { why: 'the site never answered' });
    const dead = await until(
      () => second.deadLetters(flaky),
      (rows) => rows.length > 0,
    );
    expect(dead).toEqual([
      {
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        payload: { why: 'the site never answered' },
        progress: undefined,
        reason: 'cannot: the site never answered',
        failedAt: expect.any(Date),
      },
    ]);
    // The original is terminal, and it was tried as many times as the definition allows.
    expect(await second.status(flaky, id)).toMatchObject({ state: 'failed', attempts: 2 });
  });
});
