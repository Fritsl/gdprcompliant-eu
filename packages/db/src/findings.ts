import { eq, inArray } from 'drizzle-orm';
import { CompanySchema, type Company, type Evidence, type Finding } from '@gc/contracts';
import type { Catalogue } from '@gc/remedies';
import type { Connection } from './client.js';
import {
  SHARED_TENANT,
  cases,
  evidence as evidenceTable,
  findingEvidence,
  findings,
  remedies,
} from './schema.js';
import { withTenant } from './tenant.js';

// Storing what a scan raised (T-08): evidence first (immutable, content-addressed), then
// findings with their binding and remedy, then the join rows. Everything as the case's
// tenant. The remedy catalogue is shared reference data seeded once per database.

export async function seedRemedies(connection: Connection, catalogue: Catalogue): Promise<number> {
  const rows = catalogue.all().map((e) => ({
    id: e.remedy.id,
    version: e.remedy.version,
    tenantId: SHARED_TENANT,
    sourceRef: 'catalogue',
    findingTypeId: e.remedy.findingTypeId,
    kind: e.remedy.kind,
    jurisdictions: e.remedy.jurisdictions,
    content: e.remedy,
    hash: e.hash,
  }));
  if (rows.length === 0) return 0;
  const inserted = await withTenant(connection, SHARED_TENANT, (tx) =>
    tx.insert(remedies).values(rows).onConflictDoNothing().returning({ id: remedies.id }),
  );
  return inserted.length;
}

export async function storeEvidence(
  connection: Connection,
  tenantId: string,
  items: readonly Evidence[],
): Promise<number> {
  if (items.length === 0) return 0;
  const inserted = await withTenant(connection, tenantId, (tx) =>
    tx
      .insert(evidenceTable)
      .values(
        items.map((e) => ({
          id: e.id,
          tenantId,
          sourceRef: e.scanId ? `scanner:${e.scanId}` : 'scanner',
          caseId: e.caseId,
          scanId: e.scanId ?? null,
          kind: e.kind,
          capturedAt: new Date(e.capturedAt),
          observed: e.source,
          body: e.body,
          hash: e.hash,
          caption: e.caption ?? null,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: evidenceTable.id }),
  );
  return inserted.length;
}

export async function storeFindings(
  connection: Connection,
  tenantId: string,
  items: readonly Finding[],
): Promise<number> {
  if (items.length === 0) return 0;
  return withTenant(connection, tenantId, async (tx) => {
    await tx.insert(findings).values(
      items.map((f) => ({
        id: f.id,
        tenantId,
        sourceRef: f.scanId ? `scanner:${f.scanId}` : 'scanner',
        caseId: f.caseId,
        scanId: f.scanId ?? null,
        typeId: f.typeId,
        fingerprint: f.fingerprint,
        jurisdiction: f.jurisdiction,
        binding: f.binding,
        severity: f.severity,
        status: f.status,
        area: f.area,
        subject: f.subject ?? null,
        remedyId: f.remedy.remedyId,
        remedyVersion: f.remedy.version,
        firstSeenAt: new Date(f.firstSeenAt),
        lastSeenAt: new Date(f.lastSeenAt),
      })),
    );
    // One join per evidence row; the first quote given for it is the one kept.
    const joins = items.flatMap((f) => {
      const seen = new Map<string, string | null>();
      for (const e of f.evidence)
        if (!seen.has(e.evidenceId)) seen.set(e.evidenceId, e.quote ?? null);
      return [...seen].map(([evidenceId, quote]) => ({
        findingId: f.id,
        evidenceId,
        tenantId,
        sourceRef: f.scanId ? `scanner:${f.scanId}` : 'scanner',
        quote,
      }));
    });
    if (joins.length > 0) await tx.insert(findingEvidence).values(joins);
    return items.length;
  });
}

export async function findingsForCase(connection: Connection, tenantId: string, caseId: string) {
  return withTenant(connection, tenantId, (tx) =>
    tx.select().from(findings).where(eq(findings.caseId, caseId)).orderBy(findings.typeId),
  );
}

export interface Reconciliation {
  readonly opened: string[];
  readonly seenAgain: string[];
  readonly regressed: string[];
  readonly closed: string[];
}

// A re-scan against what the case already holds (S-14): the same identity is the same
// finding, seen again; a finding that was closed and is back is regressed; one that is
// no longer observed is closed. Ids never change, so a colleague's list, a remedy in
// progress and the timeline all keep pointing at the same thing.
export async function reconcileFindings(
  connection: Connection,
  tenantId: string,
  caseId: string,
  observed: readonly Finding[],
  now: Date = new Date(),
  options: { readonly scope?: (row: typeof findings.$inferSelect) => boolean } = {},
): Promise<Reconciliation> {
  return withTenant(connection, tenantId, async (tx) => {
    const existing = await tx.select().from(findings).where(eq(findings.caseId, caseId));
    const byFingerprint = new Map(existing.map((r) => [r.fingerprint, r]));
    const result: Reconciliation = { opened: [], seenAgain: [], regressed: [], closed: [] };
    const fresh: Finding[] = [];
    for (const f of observed) {
      const row = byFingerprint.get(f.fingerprint);
      if (!row) {
        fresh.push(f);
        result.opened.push(f.id);
        continue;
      }
      const cameBack = row.status === 'closed';
      await tx
        .update(findings)
        .set({
          lastSeenAt: now,
          severity: f.severity,
          binding: f.binding,
          remedyId: f.remedy.remedyId,
          remedyVersion: f.remedy.version,
          ...(cameBack ? { status: 'regressed', closedAt: null } : {}),
        })
        .where(eq(findings.id, row.id));
      const joins = f.evidence.map((e) => ({
        findingId: row.id,
        evidenceId: e.evidenceId,
        tenantId,
        sourceRef: f.scanId ? `scanner:${f.scanId}` : 'scanner',
      }));
      if (joins.length > 0) await tx.insert(findingEvidence).values(joins).onConflictDoNothing();
      (cameBack ? result.regressed : result.seenAgain).push(row.id);
    }
    const seen = new Set(observed.map((f) => f.fingerprint));
    for (const row of existing) {
      if (seen.has(row.fingerprint) || row.status === 'closed') continue;
      // A targeted re-check closes only what it looked at.
      if (options.scope && !options.scope(row)) continue;
      await tx
        .update(findings)
        .set({ status: 'closed', closedAt: now })
        .where(eq(findings.id, row.id));
      result.closed.push(row.id);
    }
    if (fresh.length > 0) {
      await tx.insert(findings).values(
        fresh.map((f) => ({
          id: f.id,
          tenantId,
          sourceRef: f.scanId ? `scanner:${f.scanId}` : 'scanner',
          caseId: f.caseId,
          scanId: f.scanId ?? null,
          typeId: f.typeId,
          fingerprint: f.fingerprint,
          jurisdiction: f.jurisdiction,
          binding: f.binding,
          severity: f.severity,
          status: f.status,
          area: f.area,
          subject: f.subject ?? null,
          remedyId: f.remedy.remedyId,
          remedyVersion: f.remedy.version,
          firstSeenAt: new Date(f.firstSeenAt),
          lastSeenAt: now,
        })),
      );
      const joins = fresh.flatMap((f) =>
        [...new Set(f.evidence.map((e) => e.evidenceId))].map((evidenceId) => ({
          findingId: f.id,
          evidenceId,
          tenantId,
          sourceRef: f.scanId ? `scanner:${f.scanId}` : 'scanner',
        })),
      );
      if (joins.length > 0) await tx.insert(findingEvidence).values(joins).onConflictDoNothing();
    }
    return result;
  });
}

// The case page (U-03): every finding with the raw evidence rows that produced it, as
// the case's tenant. Open findings first, worst first, then what is closed.
export type FindingRow = typeof findings.$inferSelect;
export type EvidenceRow = typeof evidenceTable.$inferSelect;
export interface FindingWithEvidence {
  readonly finding: FindingRow;
  readonly evidence: readonly (EvidenceRow & { readonly quote: string | null })[];
}
const SEVERITY_ORDER = ['blocking', 'serious', 'advisory'];
export async function findingsWithEvidence(
  connection: Connection,
  tenantId: string,
  caseId: string,
): Promise<FindingWithEvidence[]> {
  return withTenant(connection, tenantId, async (tx) => {
    const rows = await tx.select().from(findings).where(eq(findings.caseId, caseId));
    if (rows.length === 0) return [];
    const joins = await tx
      .select({
        findingId: findingEvidence.findingId,
        quote: findingEvidence.quote,
        row: evidenceTable,
      })
      .from(findingEvidence)
      .innerJoin(evidenceTable, eq(evidenceTable.id, findingEvidence.evidenceId))
      .where(
        inArray(
          findingEvidence.findingId,
          rows.map((r) => r.id),
        ),
      );
    const rank = (f: FindingRow) =>
      (f.status === 'open' ? 0 : 10) + Math.max(0, SEVERITY_ORDER.indexOf(f.severity));
    return [...rows]
      .sort((a, b) => rank(a) - rank(b) || a.typeId.localeCompare(b.typeId))
      .map((f) => ({
        finding: f,
        evidence: joins
          .filter((j) => j.findingId === f.id)
          .sort((a, b) => a.row.capturedAt.getTime() - b.row.capturedAt.getTime())
          .map((j) => ({ ...j.row, quote: j.quote })),
      }));
  });
}

export async function caseCompany(
  connection: Connection,
  tenantId: string,
  caseId: string,
): Promise<Company | undefined> {
  const [row] = await withTenant(connection, tenantId, (tx) =>
    tx.select({ company: cases.company }).from(cases).where(eq(cases.id, caseId)).limit(1),
  );
  return row ? CompanySchema.parse(row.company) : undefined;
}
