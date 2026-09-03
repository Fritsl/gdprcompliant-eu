import { and, isNull, lt, or } from 'drizzle-orm';
import type { Connection } from './client.js';
import { deleteCase } from './export.js';
import { purgeDemandEntries, demandRetentionCutoff } from './demand.js';
import { expireUnclaimedCases } from './cases.js';
import { caseClaims, cases } from './schema.js';

// Retention (O-02): everything the system holds has a declared lifetime, and a job that
// enforces it. The declarations are the source of truth a CI check reads against the
// schema, so a table without a rule cannot land. docs/decisions/retention.md.

export type RetentionRule =
  // Reference data shared by every tenant; no personal data; kept.
  | { readonly kind: 'shared_reference' }
  // Rows that belong to a case and go with it: the owner's delete, or the unclaimed
  // expiry, takes them.
  | { readonly kind: 'with_case' }
  // The case itself: claimed, until its owner deletes it; unclaimed, expired and purged
  // on a clock.
  | { readonly kind: 'case'; readonly unclaimedDays: number; readonly graceDays: number }
  // Kept for a fixed period from a timestamp column, then deleted.
  | { readonly kind: 'months'; readonly months: number; readonly from: string }
  // A pending proof: gone once used or expired, after a short tail.
  | { readonly kind: 'claim'; readonly tailDays: number }
  // Anonymous by construction; kept so a deletion can be shown to have happened.
  | { readonly kind: 'anonymous_forever' };

export const UNCLAIMED_PURGE_GRACE_DAYS = 7;
export const CLAIM_TAIL_DAYS = 30;

// One entry per table, by database name. The check script fails on any table missing.
export const RETENTION: Readonly<Record<string, RetentionRule>> = {
  app_meta: { kind: 'shared_reference' },
  jurisdictions: { kind: 'shared_reference' },
  remedies: { kind: 'shared_reference' },
  corpus_chunks: { kind: 'shared_reference' },
  tenants: { kind: 'with_case' },
  cases: { kind: 'case', unclaimedDays: 30, graceDays: UNCLAIMED_PURGE_GRACE_DAYS },
  case_events: { kind: 'with_case' },
  evidence: { kind: 'with_case' },
  findings: { kind: 'with_case' },
  finding_evidence: { kind: 'with_case' },
  vendors: { kind: 'with_case' },
  processing_activities: { kind: 'with_case' },
  answers: { kind: 'with_case' },
  case_claims: { kind: 'claim', tailDays: CLAIM_TAIL_DAYS },
  case_members: { kind: 'with_case' },
  mail_outbox: { kind: 'with_case' },
  demand_entries: { kind: 'months', months: 24, from: 'seen_at' },
  deletion_audit: { kind: 'anonymous_forever' },
};

export interface RetentionRun {
  readonly at: string;
  // Cases that passed their expiry and got their closing event.
  readonly expired: readonly string[];
  // Cases purged: expired, unclaimed, and past the grace period. Stub ids, not numbers.
  readonly purged: readonly { readonly stubId: string; readonly rowsRemoved: number }[];
  readonly claimsRemoved: number;
  readonly demandEntriesRemoved: number;
  readonly durationMs: number;
}

const daysAgo = (now: Date, days: number) => new Date(now.getTime() - days * 86_400_000);

// Unclaimed cases past expiry and grace: every row of each, through the same hard
// delete an owner gets, so what remains is the same anonymous stub.
export async function purgeExpiredUnclaimedCases(
  connection: Connection,
  now: Date = new Date(),
  graceDays: number = UNCLAIMED_PURGE_GRACE_DAYS,
): Promise<{ stubId: string; rowsRemoved: number }[]> {
  const due = await connection.db
    .select({ id: cases.id, tenantId: cases.tenantId })
    .from(cases)
    .where(and(isNull(cases.claimedAt), lt(cases.expiresAt, daysAgo(now, graceDays))));
  const out: { stubId: string; rowsRemoved: number }[] = [];
  for (const c of due) {
    const stub = await deleteCase(connection, c.tenantId, c.id, {
      requestedBy: 'retention',
      reason: 'unclaimed past expiry',
      now: () => now,
    });
    out.push({ stubId: stub.id, rowsRemoved: stub.rowsRemoved });
  }
  return out;
}

// Claims that were used, or expired unused, more than the tail ago.
export async function purgeStaleClaims(
  connection: Connection,
  now: Date = new Date(),
  tailDays: number = CLAIM_TAIL_DAYS,
): Promise<number> {
  const cutoff = daysAgo(now, tailDays);
  const gone = await connection.db
    .delete(caseClaims)
    .where(
      or(
        lt(caseClaims.usedAt, cutoff),
        and(isNull(caseClaims.usedAt), lt(caseClaims.expiresAt, cutoff)),
      ),
    )
    .returning({ id: caseClaims.id });
  return gone.length;
}

// The whole sweep, in the order the rules imply. Runs as the owner; idempotent.
export async function runRetention(
  connection: Connection,
  now: Date = new Date(),
): Promise<RetentionRun> {
  const started = Date.now();
  const expired = await expireUnclaimedCases(connection, now);
  const purged = await purgeExpiredUnclaimedCases(connection, now);
  const claimsRemoved = await purgeStaleClaims(connection, now);
  const demandEntriesRemoved = await purgeDemandEntries(connection.db, demandRetentionCutoff(now));
  return {
    at: now.toISOString(),
    expired,
    purged,
    claimsRemoved,
    demandEntriesRemoved,
    durationMs: Date.now() - started,
  };
}

// For the retention test: does any row anywhere still carry this text?
export async function textSurvivesAnywhere(
  connection: Connection,
  needle: string,
): Promise<string[]> {
  const rows = await connection.sql<{ table_name: string }[]>`
    select table_name from information_schema.tables
    where table_schema = current_schema() and table_type = 'BASE TABLE' and table_name <> '__drizzle_migrations'`;
  const found: string[] = [];
  for (const { table_name } of rows) {
    const [hit] = await connection.sql<{ n: number }[]>`
      select count(*)::int as n from ${connection.sql(table_name)} t where t::text like ${'%' + needle + '%'}`;
    if (Number(hit?.n ?? 0) > 0) found.push(table_name);
  }
  return found;
}
