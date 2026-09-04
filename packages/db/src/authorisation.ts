import { and, desc, eq } from 'drizzle-orm';
import type { Actor } from '@gc/contracts';
import type { Connection } from './client.js';
import { caseEvents, cases } from './schema.js';
import { appendCaseEvent } from './timeline.js';
import { withTenant } from './tenant.js';

// Who may run a deep scan on whom (D-11). The ordinary scan reads what any visitor
// gets and needs no permission. The deep scan reads a site's suppliers and theirs, and
// runs only for a case whose owner has proved control of the domain by claiming it
// (C-01: an email at the domain, answered), or where a decision in the public interest
// has been recorded on the case with its reason and the person who made it. Neither
// is quiet: the claim and the decision are both on the timeline, and a refusal says
// which of the two is missing.

export type DeepScanAuthorisation =
  | {
      readonly allowed: true;
      readonly basis: 'domain_control';
      readonly claimedBy: string;
      readonly at: string;
    }
  | {
      readonly allowed: true;
      readonly basis: 'public_interest';
      readonly reason: string;
      readonly by: Actor;
      readonly at: string;
    }
  | { readonly allowed: false; readonly reason: string };

export const DEEP_SCAN_REFUSED =
  'the case is not claimed and no public-interest decision is recorded on it';

export async function deepScanAuthorisation(
  connection: Connection,
  tenantId: string,
  caseId: string,
): Promise<DeepScanAuthorisation> {
  return withTenant(connection, tenantId, async (db) => {
    const [row] = await db
      .select({ claimedAt: cases.claimedAt, claimedBy: cases.claimedBy })
      .from(cases)
      .where(eq(cases.id, caseId))
      .limit(1);
    if (!row) return { allowed: false, reason: `no case ${caseId}` };
    if (row.claimedAt) {
      return {
        allowed: true,
        basis: 'domain_control',
        claimedBy: row.claimedBy ?? 'unknown',
        at: row.claimedAt.toISOString(),
      };
    }
    const [decision] = await db
      .select()
      .from(caseEvents)
      .where(and(eq(caseEvents.caseId, caseId), eq(caseEvents.type, 'deep_scan_authorised')))
      .orderBy(desc(caseEvents.at))
      .limit(1);
    if (decision) {
      const payload = decision.payload as { reason: string };
      return {
        allowed: true,
        basis: 'public_interest',
        reason: payload.reason,
        by: decision.actor as Actor,
        at: decision.at.toISOString(),
      };
    }
    return { allowed: false, reason: DEEP_SCAN_REFUSED };
  });
}

export interface PublicInterestDecision {
  readonly caseId: string;
  // Why the public interest calls for it, in words a reader of the timeline understands.
  readonly reason: string;
  // The person who decided; never the system, never the scanner.
  readonly by: Actor & { readonly kind: 'person' };
  readonly now?: Date;
}

// The documented path: a person records the decision and its reason on the case.
export async function authoriseDeepScan(
  connection: Connection,
  tenantId: string,
  input: PublicInterestDecision,
): Promise<void> {
  const reason = input.reason.trim();
  if (reason.length < 20) throw new Error('a public-interest decision states its reason in full');
  await withTenant(connection, tenantId, (db) =>
    appendCaseEvent(db, {
      tenantId,
      caseId: input.caseId,
      at: input.now ?? new Date(),
      actor: input.by,
      type: 'deep_scan_authorised',
      payload: { reason, basis: 'public_interest' },
    }),
  );
}
