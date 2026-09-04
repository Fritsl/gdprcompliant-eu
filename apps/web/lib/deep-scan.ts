import 'server-only';
import { DEEP_SCAN_JOB, caseByToken, deepScanStatus, type DeepScanProgress } from '@gc/db';
import { JobQueue } from '@gc/jobs';
import { holder, withConnection } from '@/lib/case';

// The deep scan from the case page (T-09): the owner of a claimed case asks for it, the
// worker runs the planner over the case and reads the suppliers, and the page reads the
// job back while it runs. An unclaimed case is told to claim first; nothing is enqueued.

export type DeepScanOutcome = 'queued' | 'unclaimed' | 'not_found';

export async function deepScanForOwner(
  token: string,
): Promise<{ outcome: DeepScanOutcome; jobId?: string }> {
  const result = await withConnection(async (connection) => {
    const found = await caseByToken(connection, token);
    if (!found) return { outcome: 'not_found' as const };
    if (!found.claimed) return { outcome: 'unclaimed' as const };
    const url = process.env['DATABASE_URL'];
    if (!url) return { outcome: 'not_found' as const };
    const queue = new JobQueue({ connectionString: url });
    await queue.start();
    try {
      const jobId = await queue.enqueue(DEEP_SCAN_JOB, {
        tenantId: found.tenantId,
        caseId: found.caseId,
        requestedBy: holder(found.caseId),
      });
      return { outcome: 'queued' as const, jobId };
    } finally {
      await queue.stop({ graceful: true });
    }
  });
  return result ?? { outcome: 'not_found' };
}

export interface DeepScanView {
  readonly id: string;
  readonly state: string;
  readonly progress?: DeepScanProgress;
}

export async function readDeepScan(
  token: string,
  jobId: string,
): Promise<DeepScanView | undefined> {
  return withConnection(async (connection) => {
    const found = await caseByToken(connection, token);
    if (!found) return undefined;
    const url = process.env['DATABASE_URL'];
    if (!url) return undefined;
    const queue = new JobQueue({ connectionString: url });
    await queue.start();
    try {
      const status = await deepScanStatus(queue, jobId);
      if (!status || status.payload.caseId !== found.caseId) return undefined;
      return {
        id: jobId,
        state: status.state,
        ...(status.progress ? { progress: status.progress } : {}),
      };
    } finally {
      await queue.stop({ graceful: true });
    }
  });
}
