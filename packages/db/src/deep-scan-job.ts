import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  ActorSchema,
  CaseIdSchema,
  CaseSchema,
  CompanySchema,
  TASK_TYPES,
  TenantIdSchema,
  type Case,
} from '@gc/contracts';
import { defineJob, type JobQueue } from '@gc/jobs';
import type { Connection } from './client.js';
import type { CaseGraph } from './graph.js';
import { cases } from './schema.js';
import { withTenant } from './tenant.js';

// The deep scan (A-06, D-06, D-07, D-11, T-09): the planner's run over a case whose
// owner has proved control of the domain. The web app enqueues; the worker plans from
// the case as it stands, reads the suppliers' agreements and their sub-processors, and
// records what it found as a scan of its own kind. The job's progress is what the case
// page shows while it runs.

export const DEEP_SCAN_OUTCOMES = ['done', 'refused', 'failed'] as const;
export type DeepScanOutcome = (typeof DEEP_SCAN_OUTCOMES)[number];

export const DeepScanProgressSchema = z.object({
  stage: z.string().max(80).optional(),
  outcome: z.enum(DEEP_SCAN_OUTCOMES).optional(),
  detail: z.string().max(300).optional(),
  // The plan the planner made, one line of rationale per task, for the case to show.
  plan: z.array(z.object({ type: z.enum(TASK_TYPES), rationale: z.string().max(300) })).optional(),
  source: z.enum(['heuristic', 'model']).optional(),
  suppliers: z.number().int().min(0).optional(),
  findings: z.number().int().min(0).optional(),
  at: z.iso.datetime().optional(),
});
export type DeepScanProgress = z.infer<typeof DeepScanProgressSchema>;

export const DEEP_SCAN_JOB = defineJob({
  name: 'deep-scan',
  payload: z.object({
    tenantId: TenantIdSchema,
    caseId: CaseIdSchema,
    requestedBy: ActorSchema,
    now: z.iso.datetime().optional(),
  }),
  progress: DeepScanProgressSchema,
  retryLimit: 0,
  expireInSeconds: 15 * 60,
});
export type DeepScanPayload = z.infer<typeof DEEP_SCAN_JOB.payload>;

export async function deepScanStatus(queue: JobQueue, id: string) {
  return queue.status(DEEP_SCAN_JOB, id);
}

// The case as the planner's contract has it, read from the row.
export async function caseForPlanner(
  connection: Connection,
  tenantId: string,
  caseId: string,
): Promise<Case | undefined> {
  const [row] = await withTenant(connection, tenantId, (db) =>
    db.select().from(cases).where(eq(cases.id, caseId)).limit(1),
  );
  if (!row) return undefined;
  return CaseSchema.parse({
    id: row.id,
    tenantId,
    company: CompanySchema.parse(row.company),
    jurisdiction: row.jurisdiction,
    locale: row.locale,
    openedAt: row.openedAt.toISOString(),
    ...(row.owner ? { owner: row.owner } : {}),
    participants: row.participants,
    watched: row.watched,
    lane: row.lane,
    laneScore: row.laneScore,
    stage: row.stage,
  });
}

// The suppliers a deep scan reads: every vendor the graph names by host, outside the
// site itself, with the name the register gave it.
export interface SupplierHost {
  readonly nodeId: string;
  readonly host: string;
  readonly name: string;
  readonly unresolved: boolean;
}

const withinSite = (host: string, domain: string): boolean => {
  const h = host.toLowerCase();
  const d = domain.toLowerCase();
  return h === d || h.endsWith(`.${d}`);
};

export function supplierHosts(graph: CaseGraph, domain: string): SupplierHost[] {
  const out = new Map<string, SupplierHost>();
  for (const n of graph.nodes) {
    if (n.kind !== 'vendor' || n.supersededBy) continue;
    const hosts = Array.isArray(n.attributes['hosts']) ? (n.attributes['hosts'] as string[]) : [];
    const name = typeof n.attributes['name'] === 'string' ? n.attributes['name'] : hosts[0];
    for (const host of hosts) {
      if (typeof host !== 'string' || !host || withinSite(host, domain) || out.has(host)) continue;
      out.set(host, {
        nodeId: n.id,
        host,
        name: name ?? host,
        unresolved: n.attributes['unresolved'] === true,
      });
    }
  }
  return [...out.values()].sort((a, b) => a.host.localeCompare(b.host));
}
