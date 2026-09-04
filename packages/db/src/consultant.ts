import { eq } from 'drizzle-orm';
import type { CaseLane, FindingStatus, RemedyKind, Severity } from '@gc/contracts';
import type { Connection } from './client.js';
import { caseCompany } from './findings.js';
import { laneOf, type LaneSignal } from './lane.js';
import { rankCase, type QueueFinding, type QueueRow } from './queue.js';
import { findings } from './schema.js';
import { withTenant } from './tenant.js';
import { appendEvent, caseTimeline } from './timeline.js';

// The consultant view (L-02): one of us opens the customer's case already briefed. The
// brief is generated from what the case holds, the lane and the queue row; nothing is
// written except the fact of the opening, which lands on the timeline as a person the
// customer can see. There is no place for a private note on a customer-visible object.

export interface InternalUser {
  readonly userId: string;
  readonly name: string;
}

export interface BriefSignal {
  readonly label: string;
  readonly value: string;
  readonly level: 'low' | 'mid' | 'high';
  readonly because: string;
}

export interface ConsultantBrief {
  readonly caseId: string;
  readonly headline: string;
  readonly lane: CaseLane;
  readonly score: number;
  readonly signals: readonly BriefSignal[];
  readonly queue: QueueRow;
  // What to make of it, in a sentence or two, from the signals and the queue row.
  readonly read: string;
  // What the customer sees of us: how often the case has been opened, by name.
  readonly visible: string;
  readonly opened: number;
}

export interface OpenAsConsultantOptions {
  readonly by: InternalUser;
  readonly remedy: (remedyId: string, version: number) => { kind: RemedyKind; title?: string };
  readonly now?: () => Date;
}

const levelOf = (s: LaneSignal): BriefSignal['level'] =>
  s.points >= 15 ? 'high' : s.points > 0 ? 'mid' : 'low';

const times = (n: number): string => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);

export function briefRead(lane: CaseLane, signals: readonly LaneSignal[], queue: QueueRow): string {
  const budget = signals
    .filter((s) => s.points > 0)
    .map((s) => `${s.label.toLowerCase()} ${s.value}`);
  const opener = queue.hook
    ? `Open with ${queue.hook.typeId}${queue.hook.title ? `: ${queue.hook.title}` : ''}.`
    : 'Nothing open to call about; wait for the next scan.';
  if (lane === 'human')
    return `Budget signals: ${budget.join(', ')}. ${queue.why[1]}, ${queue.why[2]}. ${opener}`;
  return `No budget signals${budget.length > 0 ? ` beyond ${budget.join(', ')}` : ''}. Automated product only; do not assign a consultant. ${opener}`;
}

export async function openAsConsultant(
  connection: Connection,
  tenantId: string,
  caseId: string,
  options: OpenAsConsultantOptions,
): Promise<ConsultantBrief | undefined> {
  const company = await caseCompany(connection, tenantId, caseId);
  if (!company) return undefined;
  const lane = await laneOf(connection, tenantId, caseId);
  if (!lane) return undefined;
  const at = (options.now ?? (() => new Date()))();
  const actor = {
    kind: 'person' as const,
    userId: `staff:${options.by.userId}`,
    name: options.by.name,
  };
  const [rows, events] = await withTenant(connection, tenantId, async (db) => {
    const found = await db.select().from(findings).where(eq(findings.caseId, caseId));
    await appendEvent(db, tenantId, caseId, at, actor, 'internal_access', {
      name: options.by.name,
    });
    return [found, await caseTimeline(db, caseId)] as const;
  });
  const queue = rankCase({
    caseId,
    company: company.legalName ?? company.domain,
    lane: lane.lane,
    score: lane.score,
    findings: rows.map((f): QueueFinding => {
      const remedy = options.remedy(f.remedyId, f.remedyVersion);
      return {
        id: f.id,
        typeId: f.typeId,
        severity: f.severity as Severity,
        status: f.status as FindingStatus,
        remedyKind: remedy.kind,
        title: remedy.title,
      };
    }),
  });
  const opened = events.filter((e) => e.type === 'internal_access').length;
  const byMe = events.filter(
    (e) =>
      e.type === 'internal_access' && e.actor.kind === 'person' && e.actor.userId === actor.userId,
  ).length;
  return {
    caseId,
    headline: `${company.legalName ?? company.domain} · ${caseId}`,
    lane: lane.lane,
    score: lane.score,
    signals: lane.signals.map((s) => ({
      label: s.label,
      value: s.value,
      level: levelOf(s),
      because: s.because,
    })),
    queue,
    read: briefRead(lane.lane, lane.signals, queue),
    visible: `This case has been opened by ${options.by.name} ${times(byMe)}${opened > byMe ? `, and ${times(opened)} in all` : ''}. Every opening is on the customer's timeline.`,
    opened,
  };
}
