import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  type Actor,
  type Evidence,
  type Finding,
  type FindingStatus,
  type FindingTypeId,
  type Verification,
} from '@gc/contracts';
import {
  assembleFindings,
  checkFamilyFor,
  typesInFamily,
  type AssemblyInput,
  type CheckFamily,
} from '@gc/findings';
import { defineJob, type JobQueue } from '@gc/jobs';
import type { Catalogue } from '@gc/remedies';
import type { Connection } from './client.js';
import { reconcileFindings, storeEvidence, type Reconciliation } from './findings.js';
import { cases, findings } from './schema.js';
import { withTenant } from './tenant.js';
import { appendCaseEvent } from './timeline.js';
import {
  driftDrafts,
  driftEvidence,
  noResolver,
  policyDrift,
  type DriftReport,
  type HostResolver,
} from './drift.js';

// The re-scan and fix verification loop (C-05). A scan's result is recorded against the
// case: evidence stored, findings reconciled (opened, seen again, closed, regressed),
// and every change on the timeline with its date. Pressing re-check on one finding
// re-runs only the family its detector belongs to and reconciles only that family, so
// a targeted check costs a fraction of a scan and cannot close what it did not look
// at. A remedy verified by attestation, an answer or a published document is not
// re-scanned; its own path closes it. The weekly watch runs everything and speaks only
// when something changed.

export interface ScanResultInput {
  readonly scanId: string;
  readonly kind: 'initial' | 'recheck' | 'watch' | 'deep';
  readonly findings: readonly Finding[];
  readonly evidence: readonly Evidence[];
  readonly checksRun: number;
  readonly checksPassed: number;
  readonly undetermined: number;
  readonly actor: Actor;
  readonly now: Date;
  // Reconcile only findings of these types; others are left alone.
  readonly scope?: ReadonlySet<string>;
}

export interface ScanRecord extends Reconciliation {
  readonly scanId: string;
  readonly changes: number;
}

export async function recordScan(
  connection: Connection,
  tenantId: string,
  caseId: string,
  input: ScanResultInput,
): Promise<ScanRecord> {
  await withTenant(connection, tenantId, (tx) =>
    appendCaseEvent(tx, {
      tenantId,
      caseId,
      at: input.now,
      actor: input.actor,
      type: 'scan_started',
      payload: { scanId: input.scanId, kind: input.kind },
    }),
  );
  await storeEvidence(
    connection,
    tenantId,
    input.evidence.map((e) => ({ ...e, tenantId, caseId })),
  );
  const r = await reconcileFindings(
    connection,
    tenantId,
    caseId,
    input.findings,
    input.now,
    input.scope ? { scope: (row) => input.scope!.has(row.typeId) } : {},
  );
  const byId = new Map(input.findings.map((f) => [f.id, f]));
  await withTenant(connection, tenantId, async (tx) => {
    const at = new Date(input.now.getTime() + 1);
    for (const id of r.opened) {
      const f = byId.get(id)!;
      await appendCaseEvent(tx, {
        tenantId,
        caseId,
        at,
        actor: input.actor,
        type: 'finding_raised',
        payload: { findingId: id, typeId: f.typeId, severity: f.severity },
      });
    }
    for (const id of r.closed) {
      await appendCaseEvent(tx, {
        tenantId,
        caseId,
        at,
        actor: input.actor,
        type: 'finding_closed',
        payload: { findingId: id, verifiedBy: 'rescan' },
      });
    }
    for (const id of r.regressed) {
      await appendCaseEvent(tx, {
        tenantId,
        caseId,
        at,
        actor: input.actor,
        type: 'finding_regressed',
        payload: { findingId: id },
      });
    }
    await appendCaseEvent(tx, {
      tenantId,
      caseId,
      at: new Date(input.now.getTime() + 2),
      actor: input.actor,
      type: 'scan_completed',
      payload: {
        scanId: input.scanId,
        checksRun: input.checksRun,
        checksPassed: input.checksPassed,
        findings: input.findings.length,
        undetermined: input.undetermined,
      },
    });
  });
  return {
    ...r,
    scanId: input.scanId,
    changes: r.opened.length + r.closed.length + r.regressed.length,
  };
}

// What the finding's remedy says closes it (R-01).
export function verificationFor(
  finding: Pick<Finding, 'remedy'>,
  catalogue: Catalogue,
): Verification | undefined {
  return catalogue.get(finding.remedy.remedyId, finding.remedy.version)?.remedy.verification;
}

// What a re-check needs from the scanner: the families to run, and what came back.
export interface CheckRun {
  readonly families: readonly CheckFamily[];
  readonly input: AssemblyInput;
  readonly evidence: readonly Evidence[];
  readonly checksRun: number;
  readonly checksPassed: number;
  readonly undetermined: number;
  readonly durationMs: number;
}
export type CheckRunner = (families: readonly CheckFamily[]) => Promise<CheckRun>;

export interface ReverifyOptions {
  readonly catalogue: Catalogue;
  readonly run: CheckRunner;
  readonly actor: Actor;
  readonly now?: () => Date;
  readonly scanId?: string;
  readonly host: string;
  readonly sectorCode?: string;
}

export type ReverifyOutcome =
  | {
      readonly method: 'rescan';
      readonly family: CheckFamily;
      readonly closed: boolean;
      readonly record: ScanRecord;
      readonly durationMs: number;
    }
  | {
      readonly method: Exclude<Verification['method'], 'rescan'>;
      readonly verification: Verification;
    }
  | { readonly method: 'none'; readonly reason: string };

export async function reverifyFinding(
  connection: Connection,
  tenantId: string,
  findingId: string,
  options: ReverifyOptions,
): Promise<ReverifyOutcome> {
  const row = await withTenant(connection, tenantId, async (tx) => {
    const [r] = await tx.select().from(findings).where(eq(findings.id, findingId));
    if (!r) throw new Error(`no finding ${findingId}`);
    return r;
  });
  const verification = verificationFor(
    { remedy: { remedyId: row.remedyId, version: row.remedyVersion } },
    options.catalogue,
  );
  if (!verification)
    return { method: 'none', reason: `remedy ${row.remedyId} is not in the catalogue` };
  if (verification.method !== 'rescan') return { method: verification.method, verification };
  const family = checkFamilyFor(row.typeId as FindingTypeId);
  if (!family) return { method: 'none', reason: `${row.typeId} has no scanner family to re-run` };

  const now = (options.now ?? (() => new Date()))();
  const scanId = options.scanId ?? `recheck-${findingId}-${now.getTime()}`;
  const existing = await withTenant(connection, tenantId, (tx) =>
    tx.select().from(findings).where(eq(findings.caseId, row.caseId)),
  );
  const previous = new Map(existing.map((r) => [r.fingerprint, r.status as FindingStatus]));
  const [caseRow] = await withTenant(connection, tenantId, (tx) =>
    tx.select({ jurisdiction: cases.jurisdiction }).from(cases).where(eq(cases.id, row.caseId)),
  );
  const run = await options.run([family]);
  const assembled = assembleFindings(run.input, {
    tenantId,
    caseId: row.caseId,
    jurisdiction: (caseRow?.jurisdiction ?? row.jurisdiction) as Finding['jurisdiction'],
    catalogue: options.catalogue,
    host: options.host,
    scanId,
    now: () => now,
    previous,
    ...(options.sectorCode ? { sectorCode: options.sectorCode } : {}),
  });
  const record = await recordScan(connection, tenantId, row.caseId, {
    scanId,
    kind: 'recheck',
    findings: assembled.findings,
    evidence: run.evidence,
    checksRun: run.checksRun,
    checksPassed: run.checksPassed,
    undetermined: run.undetermined,
    actor: options.actor,
    now,
    scope: new Set(typesInFamily(family)),
  });
  return {
    method: 'rescan',
    family,
    closed: record.closed.includes(findingId),
    record,
    durationMs: run.durationMs,
  };
}

// The customer confirms what the scanner cannot see. Closes the finding with the
// statement on the timeline; only a person can attest.
export async function attestFinding(
  connection: Connection,
  tenantId: string,
  findingId: string,
  attestation: { readonly by: Actor; readonly statement: string; readonly now?: Date },
): Promise<void> {
  if (attestation.by.kind !== 'person') throw new Error('only a person can attest');
  const now = attestation.now ?? new Date();
  await withTenant(connection, tenantId, async (tx) => {
    const [row] = await tx.select().from(findings).where(eq(findings.id, findingId));
    if (!row) throw new Error(`no finding ${findingId}`);
    await tx
      .update(findings)
      .set({ status: 'closed', closedAt: now })
      .where(eq(findings.id, findingId));
    await appendCaseEvent(tx, {
      tenantId,
      caseId: row.caseId,
      at: now,
      actor: attestation.by,
      type: 'note_added',
      payload: { text: attestation.statement },
    });
    await appendCaseEvent(tx, {
      tenantId,
      caseId: row.caseId,
      at: new Date(now.getTime() + 1),
      actor: attestation.by,
      type: 'finding_closed',
      payload: { findingId, verifiedBy: 'attestation' },
    });
  });
}

// ---- the weekly watch --------------------------------------------------------------

export const WATCH_JOB = defineJob({
  name: 'watch-case',
  payload: z.object({
    tenantId: z.string().min(1),
    caseId: z.string().min(1),
    now: z.iso.datetime().optional(),
  }),
  progress: z.object({ done: z.literal(true) }),
  retryLimit: 1,
  expireInSeconds: 30 * 60,
});
// Monday, half past four in the morning.
export const WATCH_CRON = '30 4 * * 1';

export interface WatchOptions {
  readonly catalogue: Catalogue;
  readonly run: CheckRunner;
  readonly host: string;
  readonly now?: () => Date;
  readonly sectorCode?: string;
  // Host to registry entry, for the drift check; the worker passes the scanner's.
  readonly resolve?: HostResolver;
}

export interface WatchRun {
  readonly scanId: string;
  readonly changes: number;
  readonly record: ScanRecord;
  readonly drift: DriftReport;
}

// Everything, again, against what the case holds; only genuine changes are raised, and
// the run itself is one timeline entry.
export async function runWatch(
  connection: Connection,
  tenantId: string,
  caseId: string,
  options: WatchOptions,
): Promise<WatchRun> {
  const now = (options.now ?? (() => new Date()))();
  const scanId = `watch-${caseId}-${now.getTime()}`;
  const existing = await withTenant(connection, tenantId, (tx) =>
    tx.select().from(findings).where(eq(findings.caseId, caseId)),
  );
  const [caseRow] = await withTenant(connection, tenantId, (tx) =>
    tx.select({ jurisdiction: cases.jurisdiction }).from(cases).where(eq(cases.id, caseId)),
  );
  if (!caseRow) throw new Error(`no case ${caseId}`);
  const run = await options.run([
    'security',
    'recipients',
    'forms',
    'replay',
    'policies',
    'consent',
  ]);
  // The published policy against what the site does now (G-05): a finding on the read
  // and on a row that says both sides.
  const drift = await policyDrift(
    connection,
    tenantId,
    caseId,
    run.input.recipients ?? [],
    options.resolve ?? noResolver,
  );
  const sides = driftEvidence(drift, {
    tenantId,
    caseId,
    scanId,
    capturedAt: now.toISOString(),
    host: options.host,
  });
  const assembled = assembleFindings(
    {
      ...run.input,
      drafts: [...(run.input.drafts ?? []), ...driftDrafts(drift, sides, options.host)],
    },
    {
      tenantId,
      caseId,
      jurisdiction: caseRow.jurisdiction as Finding['jurisdiction'],
      catalogue: options.catalogue,
      host: options.host,
      scanId,
      now: () => now,
      previous: new Map(existing.map((r) => [r.fingerprint, r.status as FindingStatus])),
      ...(options.sectorCode ? { sectorCode: options.sectorCode } : {}),
    },
  );
  const record = await recordScan(connection, tenantId, caseId, {
    scanId,
    kind: 'watch',
    findings: assembled.findings,
    evidence: [...run.evidence, ...(sides ? [sides] : [])],
    checksRun: run.checksRun,
    checksPassed: run.checksPassed,
    undetermined: run.undetermined,
    actor: { kind: 'watcher' },
    now,
  });
  await withTenant(connection, tenantId, (tx) =>
    appendCaseEvent(tx, {
      tenantId,
      caseId,
      at: new Date(now.getTime() + 3),
      actor: { kind: 'watcher' },
      type: 'watch_run',
      payload: { scanId, changes: record.changes },
    }),
  );
  return { scanId, changes: record.changes, record, drift };
}

export async function registerWatchWorker(
  queue: JobQueue,
  connection: Connection,
  options: (payload: { tenantId: string; caseId: string }) => WatchOptions,
  onRun?: (run: WatchRun) => void,
): Promise<void> {
  await queue.work(WATCH_JOB, async (job) => {
    const o = options(job.payload);
    const run = await runWatch(connection, job.payload.tenantId, job.payload.caseId, {
      ...o,
      ...(job.payload.now ? { now: () => new Date(job.payload.now!) } : {}),
    });
    onRun?.(run);
  });
}

export async function scheduleWatch(
  queue: JobQueue,
  payload: { tenantId: string; caseId: string },
): Promise<void> {
  await queue.schedule(WATCH_JOB, WATCH_CRON, payload);
}
