import 'server-only';
import { createHash } from 'node:crypto';
import {
  RateLimiter,
  SCANS_PER_SOURCE_PER_HOUR,
  SCAN_JOB,
  SCAN_QUEUE_DEPTH_CAP,
  normaliseDomain,
  scanStatus,
  type ScanProgress,
} from '@gc/db';
import { JobQueue, type JobStatus } from '@gc/jobs';
import type { Locale } from '@gc/contracts';

// The front door's side of the scan (U-02): validate the domain, hold the line against
// abuse, enqueue, and read progress back for the page and the event stream. The web
// process never runs a browser; the worker does.

export type StartOutcome =
  | { readonly ok: true; readonly jobId: string }
  | {
      readonly ok: false;
      readonly reason: 'invalid' | 'limited' | 'busy';
      readonly retryAfter?: number;
    };

const limiter = new RateLimiter(
  Number(process.env['GC_SCANS_PER_SOURCE_PER_HOUR'] ?? SCANS_PER_SOURCE_PER_HOUR),
  60 * 60 * 1000,
);
const depthCap = () => Number(process.env['GC_SCAN_QUEUE_CAP'] ?? SCAN_QUEUE_DEPTH_CAP);

// A source is an address, hashed; the address itself is never stored or logged.
export const sourceKey = (address: string): string =>
  createHash('sha256').update(address).digest('hex').slice(0, 16);

async function withQueue<T>(work: (queue: JobQueue) => Promise<T>): Promise<T | undefined> {
  const url = process.env['DATABASE_URL'];
  if (!url) return undefined;
  const queue = new JobQueue({ connectionString: url });
  await queue.start();
  try {
    return await work(queue);
  } finally {
    await queue.stop({ graceful: true });
  }
}

export async function startScan(input: {
  readonly domain: string;
  readonly locale: Locale;
  readonly source: string;
  readonly referredBy?: string | undefined;
}): Promise<StartOutcome> {
  const domain = normaliseDomain(input.domain);
  if (!domain) return { ok: false, reason: 'invalid' };
  const key = sourceKey(input.source);
  if (!limiter.allow(key))
    return { ok: false, reason: 'limited', retryAfter: limiter.retryAfter(key) };
  const result = await withQueue(async (queue) => {
    const depth = await queue.depth(SCAN_JOB);
    if (depth >= depthCap()) return { ok: false as const, reason: 'busy' as const };
    const jobId = await queue.enqueue(SCAN_JOB, {
      domain,
      locale: input.locale,
      source: 'front-door',
      requestedBy: key,
      ...(input.referredBy ? { referredBy: input.referredBy } : {}),
    });
    return { ok: true as const, jobId };
  });
  return result ?? { ok: false, reason: 'busy' };
}

export type ScanView = {
  readonly id: string;
  readonly domain: string;
  readonly state: JobStatus<unknown, unknown>['state'];
  readonly progress: ScanProgress;
  readonly done: boolean;
  readonly failed: boolean;
};

export async function readScan(id: string): Promise<ScanView | undefined> {
  return withQueue(async (queue) => {
    const status = await scanStatus(queue, id);
    if (!status) return undefined;
    const progress = status.progress ?? { stages: [] };
    const failed = status.state === 'failed' || status.state === 'cancelled';
    const done = status.state === 'completed' || failed || progress.outcome !== undefined;
    return { id, domain: status.payload.domain, state: status.state, progress, done, failed };
  });
}
