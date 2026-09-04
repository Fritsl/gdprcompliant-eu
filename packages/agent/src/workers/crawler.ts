import type { Evidence, ScanPass } from '@gc/contracts';
import type { Worker } from '../dispatcher.js';
import { claimOf, done, failed, refTo, type WorkerIdentity } from './shared.js';

// The crawler (A-05): loads the target through the browser and hands back what it saw,
// as evidence rows, one set per pass. It knows nothing of the law texts and nothing of
// the law; its only tool is the collector it is given.

export interface Collected {
  readonly pass: ScanPass;
  readonly evidence: readonly Evidence[];
}

export interface CrawlerDeps extends WorkerIdentity {
  // The scanner, narrowed to one call: the passes asked for, against one address.
  readonly collect: (
    url: string,
    passes: readonly ScanPass[],
    identity: { tenantId: string; caseId: string; scanId: string; capturedAt: string },
  ) => Promise<readonly Collected[]>;
  readonly now?: () => Date;
}

export const CRAWLER = 'crawler';

export function createCrawler(deps: CrawlerDeps): Worker<'crawl'> {
  const now = deps.now ?? (() => new Date());
  return async (task) => {
    const at = now();
    let collected: readonly Collected[];
    try {
      collected = await deps.collect(task.payload.url, task.payload.passes, {
        tenantId: deps.tenantId,
        caseId: deps.caseId,
        scanId: task.id,
        capturedAt: at.toISOString(),
      });
    } catch (e) {
      return failed(task, `the site could not be read: ${(e as Error).message}`, true);
    }
    const evidence = collected.flatMap((c) => [...c.evidence]);
    const claims = collected
      .filter((c) => c.evidence.length > 0)
      .map((c) =>
        claimOf({
          caseId: deps.caseId,
          kind: 'observation',
          statement: `Pass ${c.pass} of ${task.payload.url} produced ${c.evidence.length} evidence row(s).`,
          evidence: c.evidence.slice(0, 20).map(refTo),
          worker: CRAWLER,
          taskId: task.id,
          at,
        }),
      );
    return done(
      task,
      {
        passes: collected.map((c) => ({ pass: c.pass, evidenceIds: c.evidence.map((e) => e.id) })),
      },
      { claims, evidence },
    );
  };
}
