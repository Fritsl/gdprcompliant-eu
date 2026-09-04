import { and, gt, inArray, isNull, or } from 'drizzle-orm';
import type { CaseLane, FindingStatus, RemedyKind, Severity } from '@gc/contracts';
import type { Connection } from './client.js';
import { cases, findings } from './schema.js';

// The commercial queue (L-03): open cases ranked by signal × severity × how much of it
// we can solve, each row saying why in three lines, and each row naming the finding to
// open the call with. Contact is about a finding, never about how the product was
// used: nothing here reads a visit, a login or an export.

export interface QueueFinding {
  readonly id: string;
  readonly typeId: string;
  readonly severity: Severity;
  readonly status: FindingStatus;
  readonly remedyKind: RemedyKind;
  readonly title?: string | undefined;
}

export interface QueueCase {
  readonly caseId: string;
  readonly company: string;
  readonly lane: CaseLane;
  readonly score: number;
  readonly findings: readonly QueueFinding[];
}

export interface QueueHook {
  readonly findingId: string;
  readonly typeId: string;
  readonly title?: string | undefined;
}

export interface QueueRow {
  readonly caseId: string;
  readonly company: string;
  readonly lane: CaseLane;
  readonly score: number;
  readonly open: number;
  readonly solvable: number;
  readonly worst?: Severity | undefined;
  readonly rank: number;
  readonly hook?: QueueHook | undefined;
  readonly why: readonly string[];
}

const SEVERITY_WEIGHT: Record<Severity, number> = { blocking: 3, serious: 2, advisory: 1 };
const OPEN = new Set<FindingStatus>(['open', 'working', 'regressed']);
// What we can act on ourselves or hand to a partner; a no_solution finding is a gap.
const SOLVABLE = new Set<RemedyKind>([
  'self_fix',
  'generated_artefact',
  'our_product',
  'partner_alternative',
]);

const worstOf = (open: readonly QueueFinding[]): Severity | undefined =>
  open.length === 0
    ? undefined
    : open.reduce(
        (w, f) => (SEVERITY_WEIGHT[f.severity] > SEVERITY_WEIGHT[w] ? f.severity : w),
        open[0]!.severity,
      );

export function rankCase(c: QueueCase): QueueRow {
  const open = c.findings.filter((f) => OPEN.has(f.status));
  const solvable = open.filter((f) => SOLVABLE.has(f.remedyKind));
  const worst = worstOf(open);
  const severity = worst ? SEVERITY_WEIGHT[worst] : 0;
  const share = open.length === 0 ? 0 : solvable.length / open.length;
  const rank = Math.round(c.score * severity * share);
  // The finding to open with: the worst one we can do something about.
  const hookFinding = [...solvable].sort(
    (a, b) =>
      SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity] ||
      a.typeId.localeCompare(b.typeId) ||
      a.id.localeCompare(b.id),
  )[0];
  const why = [
    `signal ${c.score} (${c.lane})`,
    open.length === 0 ? 'nothing open' : `${open.length} open, worst ${worst}`,
    open.length === 0 ? 'nothing to solve' : `${solvable.length} of ${open.length} we can solve`,
  ];
  return {
    caseId: c.caseId,
    company: c.company,
    lane: c.lane,
    score: c.score,
    open: open.length,
    solvable: solvable.length,
    worst,
    rank,
    hook: hookFinding
      ? { findingId: hookFinding.id, typeId: hookFinding.typeId, title: hookFinding.title }
      : undefined,
    why,
  };
}

// Highest rank first; then the most open; then the case number, so the order is stable.
export function rankQueue(input: readonly QueueCase[]): QueueRow[] {
  return input
    .map(rankCase)
    .sort((a, b) => b.rank - a.rank || b.open - a.open || a.caseId.localeCompare(b.caseId));
}

export interface LoadQueueOptions {
  readonly remedy: (remedyId: string, version: number) => { kind: RemedyKind; title?: string };
  readonly now?: () => Date;
}

// Every live case, across tenants, as the owner; an internal reader only.
export async function loadQueue(
  connection: Connection,
  options: LoadQueueOptions,
): Promise<QueueRow[]> {
  const now = (options.now ?? (() => new Date()))();
  const rows = await connection.db
    .select({
      id: cases.id,
      company: cases.company,
      lane: cases.lane,
      score: cases.laneScore,
    })
    .from(cases)
    .where(or(isNull(cases.expiresAt), gt(cases.expiresAt, now)));
  if (rows.length === 0) return [];
  const found = await connection.db
    .select({
      id: findings.id,
      caseId: findings.caseId,
      typeId: findings.typeId,
      severity: findings.severity,
      status: findings.status,
      remedyId: findings.remedyId,
      remedyVersion: findings.remedyVersion,
    })
    .from(findings)
    .where(
      and(
        inArray(
          findings.caseId,
          rows.map((r) => r.id),
        ),
      ),
    );
  const byCase = new Map<string, QueueFinding[]>();
  for (const f of found) {
    const remedy = options.remedy(f.remedyId, f.remedyVersion);
    const list = byCase.get(f.caseId) ?? [];
    list.push({
      id: f.id,
      typeId: f.typeId,
      severity: f.severity as Severity,
      status: f.status as FindingStatus,
      remedyKind: remedy.kind,
      title: remedy.title,
    });
    byCase.set(f.caseId, list);
  }
  return rankQueue(
    rows.map((r) => {
      const company = r.company as { legalName?: string; domain?: string };
      return {
        caseId: r.id,
        company: company.legalName ?? company.domain ?? r.id,
        lane: r.lane as CaseLane,
        score: r.score,
        findings: byCase.get(r.id) ?? [],
      };
    }),
  );
}
