import { z } from 'zod';
import { LocaleSchema } from '@gc/contracts';
import { defineJob, type JobQueue } from '@gc/jobs';

// The scan as a job (U-02). The front door enqueues one; a worker runs the passes and
// checkpoints each stage as it happens, so what the visitor watches is the scan, not a
// spinner. The stages are the ones the prototype shows, in its order; a stage ends in
// one of the marks the prototype uses, and a case token arrives with the last one.

export const SCAN_STAGES = [
  'opening',
  'first-load',
  'banner',
  'refusing',
  'after-refusal',
  'accepting',
  'policy',
  'recipients',
  'security',
  'writing-up',
] as const;
export type ScanStage = (typeof SCAN_STAGES)[number];

export const STAGE_MARKS = ['on', 'ok', 'undet', 'na', 'skip', 'fail'] as const;
export const StageMarkSchema = z.enum(STAGE_MARKS);
export type StageMark = z.infer<typeof StageMarkSchema>;

export const ScanStageStateSchema = z.object({
  stage: z.enum(SCAN_STAGES),
  mark: StageMarkSchema,
  at: z.iso.datetime(),
  detail: z.string().optional(),
});
export type ScanStageState = z.infer<typeof ScanStageStateSchema>;

export const SCAN_OUTCOMES = ['case', 'no_banner_needed', 'no_refusal', 'unreachable'] as const;
export const ScanOutcomeSchema = z.enum(SCAN_OUTCOMES);
export type ScanOutcome = z.infer<typeof ScanOutcomeSchema>;

export const ScanProgressSchema = z.object({
  stages: z.array(ScanStageStateSchema),
  outcome: ScanOutcomeSchema.optional(),
  caseToken: z.string().optional(),
  caseId: z.string().optional(),
  findings: z.number().int().min(0).optional(),
});
export type ScanProgress = z.infer<typeof ScanProgressSchema>;

export const SCAN_JOB = defineJob({
  name: 'scan-site',
  payload: z.object({
    // The host to scan, as normaliseDomain gives it.
    domain: z.string().min(1),
    locale: LocaleSchema,
    source: z.enum(['front-door', 'internal']),
    // Who asked, for the abuse controls: a hashed source address, never the address.
    requestedBy: z.string().optional(),
    now: z.iso.datetime().optional(),
  }),
  progress: ScanProgressSchema,
  retryLimit: 0,
  expireInSeconds: 10 * 60,
});
export type ScanPayload = z.infer<typeof SCAN_JOB.payload>;

export async function scanStatus(queue: JobQueue, id: string) {
  return queue.status(SCAN_JOB, id);
}

// A domain, however the visitor typed it: with a scheme, a path, capitals, spaces around
// it, a trailing dot. Anything that is not a hostname with a dot in it is refused.
export function normaliseDomain(input: string): string | undefined {
  let s = input.trim().toLowerCase();
  if (s.length === 0 || s.length > 253) return undefined;
  if (!/^[a-z]+:\/\//.test(s)) s = `https://${s}`;
  let host: string;
  try {
    host = new URL(s).hostname;
  } catch {
    return undefined;
  }
  host = host.replace(/\.$/, '');
  if (!/^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)+$/.test(host)) {
    return undefined;
  }
  if (host === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return undefined;
  // Names that are not the web (T-06): this machine, a private network, cloud metadata.
  if (/\.(localhost|internal|local|corp|intranet|home\.arpa)$/.test(host)) return undefined;
  if (host === 'metadata.google.internal') return undefined;
  return host;
}

// A token bucket per source (U-02): so many scans per source per window, then a polite
// no. In memory, per process; enough for one front door, and the queue depth cap behind
// it holds whatever gets through.
export class RateLimiter {
  readonly #hits = new Map<string, number[]>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  // Whether this source may start one more scan now; records the attempt if so.
  allow(key: string, now: number = Date.now()): boolean {
    const recent = (this.#hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.#hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.#hits.set(key, recent);
    return true;
  }

  // Seconds until the source may try again.
  retryAfter(key: string, now: number = Date.now()): number {
    const recent = (this.#hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length < this.limit) return 0;
    return Math.ceil((recent[0]! + this.windowMs - now) / 1000);
  }
}

export const SCANS_PER_SOURCE_PER_HOUR = 5;
export const SCAN_QUEUE_DEPTH_CAP = 50;
