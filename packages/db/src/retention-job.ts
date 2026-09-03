import { z } from 'zod';
import { defineJob, type JobQueue } from '@gc/jobs';
import type { Connection } from './client.js';
import { runRetention, type RetentionRun } from './retention.js';

// The retention sweep as a job (O-02): scheduled nightly, and runnable on demand with a
// fixed clock for tests. One at a time is enough; the sweep is idempotent.

export const RETENTION_JOB = defineJob({
  name: 'retention-sweep',
  payload: z.object({
    // The clock to sweep against; the job's own time when absent.
    now: z.iso.datetime().optional(),
  }),
  progress: z.object({ done: z.literal(true) }),
  retryLimit: 1,
  expireInSeconds: 15 * 60,
});

export const RETENTION_CRON = '15 3 * * *';

export async function registerRetentionWorker(
  queue: JobQueue,
  connection: Connection,
  onRun?: (run: RetentionRun) => void,
): Promise<void> {
  await queue.work(RETENTION_JOB, async (job) => {
    const run = await runRetention(
      connection,
      job.payload.now ? new Date(job.payload.now) : new Date(),
    );
    onRun?.(run);
  });
}

export async function scheduleRetention(queue: JobQueue): Promise<void> {
  await queue.schedule(RETENTION_JOB, RETENTION_CRON, {});
}
