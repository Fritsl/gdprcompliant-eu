import { eq, inArray } from 'drizzle-orm';
import { timelineModel, timelinePdf } from '@gc/artefacts';
import { canonicalJson, sha256, type CaseEvent, type Locale } from '@gc/contracts';
import type { Connection, Db } from './client.js';
import {
  answers,
  caseClaims,
  cases,
  demandEntries,
  evidence,
  findingEvidence,
  findings,
  processingActivities,
  vendors,
} from './schema.js';
import { withTenant } from './tenant.js';
import { appendCaseEvent, caseTimeline } from './timeline.js';

// Proving the case is theirs (C-04): everything about a case as one file they can open,
// and a hard delete after which nothing remains but an anonymous note that a deletion
// happened. Both are timeline events, both are bounded in time, and the bounds are
// measured by the test, not promised. docs/decisions/export-and-delete.md.

export const EXPORT_TIME_BOUND_MS = 30_000;
export const DELETE_TIME_BOUND_MS = 30_000;

export interface CaseSummary {
  readonly caseId: string;
  readonly stage: string;
  readonly claimed: boolean;
  readonly counts: {
    readonly findings: number;
    readonly evidence: number;
    readonly answers: number;
    readonly events: number;
    readonly vendors: number;
    readonly activities: number;
  };
}

async function loadAll(db: Db, caseId: string) {
  const [c] = await db.select().from(cases).where(eq(cases.id, caseId)).limit(1);
  if (!c) throw new Error(`no case ${caseId}`);
  const [f, e, a, v, p, cl, d, events] = await Promise.all([
    db.select().from(findings).where(eq(findings.caseId, caseId)),
    db.select().from(evidence).where(eq(evidence.caseId, caseId)),
    db.select().from(answers).where(eq(answers.caseId, caseId)),
    db.select().from(vendors).where(eq(vendors.caseId, caseId)),
    db.select().from(processingActivities).where(eq(processingActivities.caseId, caseId)),
    db.select().from(caseClaims).where(eq(caseClaims.caseId, caseId)),
    db.select().from(demandEntries).where(eq(demandEntries.caseId, caseId)),
    caseTimeline(db, caseId),
  ]);
  const links =
    f.length === 0
      ? []
      : await db
          .select()
          .from(findingEvidence)
          .where(
            inArray(
              findingEvidence.findingId,
              f.map((x) => x.id),
            ),
          );
  return { c, f, e, a, v, p, cl, d, events, links };
}

// What the case page says is held. Counts only; no event is written for looking.
export async function caseSummary(
  connection: Connection,
  tenantId: string,
  caseId: string,
): Promise<CaseSummary> {
  return withTenant(connection, tenantId, async (db) => {
    const all = await loadAll(db, caseId);
    return {
      caseId,
      stage: all.c.stage,
      claimed: all.c.claimedAt !== null,
      counts: {
        findings: all.f.length,
        evidence: all.e.length,
        answers: all.a.length,
        events: all.events.length,
        vendors: all.v.length,
        activities: all.p.length,
      },
    };
  });
}

export interface ExportOptions {
  readonly locale: Locale;
  readonly now?: () => Date;
}

export interface CaseExport {
  // The whole case as JSON, openable anywhere. The timeline PDF rides inside it.
  readonly json: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly durationMs: number;
  readonly events: readonly CaseEvent[];
}

// Rows without the columns that name the tenant or carry a secret.
function omit<T extends object, K extends keyof T>(row: T, keys: readonly K[]): Omit<T, K> {
  const out = { ...row } as Record<string, unknown>;
  for (const k of keys) delete out[k as string];
  return out as Omit<T, K>;
}
const strip = <T extends { tenantId: string }>(rows: readonly T[]) =>
  rows.map((r) => omit(r, ['tenantId']));

export async function exportCase(
  connection: Connection,
  tenantId: string,
  caseId: string,
  options: ExportOptions,
): Promise<CaseExport> {
  const started = Date.now();
  const now = (options.now ?? (() => new Date()))();
  return withTenant(connection, tenantId, async (db) => {
    const all = await loadAll(db, caseId);
    const model = timelineModel(caseId, all.events, { locale: options.locale });
    const pdf = await timelinePdf(model, {
      title: 'Timeline',
      generatedAt: now,
      generatedLabel: 'Generated',
      pageLabel: (p, n) => `Page ${p} of ${n}`,
    });
    const caseRow = omit(all.c, ['accessToken', 'tenantId']);
    const bundle = {
      format: 'gdprcompliant.eu/case-export',
      version: 1,
      exportedAt: now.toISOString(),
      case: caseRow,
      findings: strip(all.f),
      findingEvidence: strip(all.links),
      evidence: strip(all.e),
      answers: strip(all.a),
      vendors: strip(all.v),
      processingActivities: strip(all.p),
      claims: all.cl.map((r) => omit(r, ['tenantId', 'codeHash'])),
      demandEntries: strip(all.d),
      timeline: all.events,
      documents: [
        {
          kind: 'timeline',
          filename: `${caseId}-timeline.pdf`,
          mediaType: 'application/pdf',
          base64: pdf.toString('base64'),
        },
      ],
    };
    const json = canonicalJson(bundle);
    const hash = sha256(json);
    await appendCaseEvent(db, {
      tenantId,
      caseId,
      at: now,
      actor: { kind: 'system' },
      type: 'export_produced',
      payload: { bytes: Buffer.byteLength(json), sha256: hash },
    });
    return {
      json,
      sha256: hash,
      bytes: Buffer.byteLength(json),
      durationMs: Date.now() - started,
      events: all.events,
    };
  });
}

export interface DeleteOptions {
  readonly requestedBy: 'token' | 'owner' | 'operator';
  readonly reason?: string;
  readonly now?: () => Date;
}

export interface DeletionStub {
  // sha256 of the case number: enough to answer "was this deleted?", not who it was.
  readonly id: string;
  readonly country: string;
  readonly year: number;
  readonly deletedAt: Date;
  readonly rowsRemoved: number;
  readonly durationMs: number;
}

export const deletionStubId = (caseId: string): string => sha256(`deleted:${caseId}`);

// The last event is written as the tenant; then delete_case, a definer function, takes
// every row of the case out in dependency order, the tenant with it when nothing else
// is left there, and writes the stub. The append-only and immutable triggers let a
// delete through only while the session names the case being erased.
export async function deleteCase(
  connection: Connection,
  tenantId: string,
  caseId: string,
  options: DeleteOptions,
): Promise<DeletionStub> {
  const started = Date.now();
  const now = (options.now ?? (() => new Date()))();
  await withTenant(connection, tenantId, (db) =>
    appendCaseEvent(db, {
      tenantId,
      caseId,
      at: now,
      actor: { kind: 'system' },
      type: 'deletion_requested',
      payload: {
        requestedBy: options.requestedBy,
        ...(options.reason ? { reason: options.reason } : {}),
      },
    }),
  );
  const [row] = await connection.sql<{ rows_removed: number }[]>`
    select delete_case(${caseId}, ${options.requestedBy}, ${deletionStubId(caseId)}, ${now.toISOString()}) as rows_removed`;
  return {
    id: deletionStubId(caseId),
    country: caseId.slice(0, 2),
    year: 2000 + Number(caseId.slice(3, 5)),
    deletedAt: now,
    rowsRemoved: Number(row?.rows_removed ?? 0),
    durationMs: Date.now() - started,
  };
}
