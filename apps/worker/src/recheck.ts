import {
  RECHECK_JOB,
  caseCompany,
  reverifyFinding,
  type CheckRun,
  type CheckRunner,
  type Connection,
  type RecheckProgress,
} from '@gc/db';
import type { JobQueue } from '@gc/jobs';
import type { Catalogue } from '@gc/remedies';
import { runChecks, type BrowserPool, type QuietOptions } from '@gc/scanner';

// The re-check worker (U-04, C-05): one finding, one check family, against the live
// site. What comes back is recorded on the case (recordScan) and reported on the job as
// it is: closed, still open, regressed, unverifiable from outside, or the site could not
// be reached. A re-check never says "fixed" because the button was pressed.

export interface RecheckWorkerOptions {
  readonly pool: BrowserPool;
  readonly catalogue: Catalogue;
  readonly quiet?: Partial<QuietOptions>;
  readonly now?: () => Date;
  readonly scheme?: 'https' | 'http';
}

type ScanFamily = 'security' | 'forms' | 'replay' | 'policies' | 'consent';

export async function registerRecheckWorker(
  queue: JobQueue,
  connection: Connection,
  options: RecheckWorkerOptions,
): Promise<void> {
  const now = options.now ?? (() => new Date());
  await queue.work(RECHECK_JOB, async (job) => {
    const { tenantId, caseId, findingId } = job.payload;
    const report = (p: RecheckProgress) => job.checkpoint({ ...p, at: now().toISOString() });
    const company = await caseCompany(connection, tenantId, caseId);
    if (!company) {
      await report({ outcome: 'unverifiable', detail: 'no such case' });
      return;
    }
    const url = `${options.scheme ?? 'https'}://${company.domain}/`;
    const run: CheckRunner = async (families) => {
      const out = await runChecks(
        options.pool,
        { url },
        {
          identity: { tenantId, caseId, scanId: job.id, capturedAt: now().toISOString() },
          families: families.filter((f): f is ScanFamily => f !== 'ct'),
          ...(options.quiet ? { quiet: options.quiet } : {}),
          now,
        },
      );
      const checkRun: CheckRun = {
        families,
        input: {
          ...(out.security ? { security: out.security } : {}),
          ...(out.forms ? { forms: out.forms } : {}),
          ...(out.replay ? { replay: out.replay } : {}),
          ...(out.policies ? { policies: out.policies } : {}),
          ...(out.consent ? { consent: out.consent } : {}),
        },
        evidence: out.evidence,
        checksRun: out.checksRun,
        checksPassed: out.checksPassed,
        undetermined: out.undetermined,
        durationMs: out.durationMs,
      };
      return checkRun;
    };
    try {
      const outcome = await reverifyFinding(connection, tenantId, findingId, {
        catalogue: options.catalogue,
        run,
        actor: job.payload.requestedBy,
        host: company.domain,
        now,
        scanId: job.id,
      });
      if (outcome.method === 'rescan') {
        await report({
          outcome: outcome.closed
            ? 'closed'
            : outcome.record.regressed.includes(findingId)
              ? 'regressed'
              : 'open',
          durationMs: outcome.durationMs,
        });
      } else if ('reason' in outcome) {
        await report({ outcome: 'unverifiable', detail: outcome.reason });
      } else {
        await report({ outcome: 'unverifiable', detail: `verified by ${outcome.method}` });
      }
    } catch (e) {
      const message = (e as Error).message ?? String(e);
      await report({ outcome: 'unreachable', detail: message.slice(0, 200) });
    }
  });
}
