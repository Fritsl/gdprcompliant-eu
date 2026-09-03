import { and, eq, sql } from 'drizzle-orm';
import {
  EvidenceSchema,
  sha256,
  type Claim,
  type Evidence,
  type VerifierVerdict,
} from '@gc/contracts';
import { createModelReview, verifyClaim, type ModelClient, type VerifierDeps } from '@gc/agent';
import { appendCaseEvent, schema, withTenant, type Connection } from '@gc/db';
import { loadDecisions } from './content.js';
import { resolveDecision } from './resolve.js';
import { resolveCitation } from './store.js';

// The verifier wired to the database (A-07): evidence is read from the claim's tenant,
// citations resolve against corpus_chunks and the decisions registry, and every verdict
// is written down. A rejection also goes on the case timeline with its reason, and sits
// in the internal review queue until someone has looked at it.

const { evidence: evidenceTable, claimVerdicts } = schema;

function toEvidence(row: typeof evidenceTable.$inferSelect): Evidence {
  return EvidenceSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    caseId: row.caseId,
    scanId: row.scanId ?? undefined,
    kind: row.kind,
    capturedAt: new Date(row.capturedAt).toISOString(),
    source: row.observed,
    body: row.body,
    hash: row.hash,
    caption: row.caption ?? undefined,
  });
}

export interface VerifierOptions {
  readonly client?: Pick<ModelClient, 'call'>;
  readonly review?: VerifierDeps['review'];
  readonly now?: () => Date;
}

export const VERIFIER_ACTOR = { kind: 'agent', name: 'verifier' } as const;

export const verdictId = (claimId: string, at: string): string =>
  `verdict:${sha256(`${claimId}\n${at}`).slice(0, 16)}`;

export async function recordVerdict(
  connection: Connection,
  tenantId: string,
  claim: Claim,
  verdict: VerifierVerdict,
): Promise<string> {
  const id = verdictId(claim.id, verdict.at);
  await withTenant(connection, tenantId, async (tx) => {
    await tx.insert(claimVerdicts).values({
      id,
      tenantId,
      sourceRef: `verifier:${claim.producedBy.worker}`,
      caseId: claim.caseId,
      claimId: claim.id,
      claimKind: claim.kind,
      statement: claim.statement,
      verdict: verdict.verdict,
      checks: verdict.checks,
      reason: verdict.reason ?? null,
      at: new Date(verdict.at),
    });
    if (verdict.verdict === 'rejected') {
      await appendCaseEvent(tx, {
        tenantId,
        caseId: claim.caseId,
        at: new Date(verdict.at),
        actor: VERIFIER_ACTOR,
        type: 'claim_rejected',
        payload: { claimId: claim.id, reason: verdict.reason ?? 'rejected' },
      });
    }
  });
  return id;
}

export function createVerifier(connection: Connection, options: VerifierOptions = {}) {
  const review =
    options.review ??
    (options.client ? createModelReview(options.client as ModelClient) : undefined);
  const decisions = loadDecisions();
  return {
    async verify(tenantId: string, claim: Claim): Promise<VerifierVerdict> {
      const deps: VerifierDeps = {
        evidence: (_, ref) =>
          withTenant(connection, tenantId, async (tx) => {
            const [row] = await tx
              .select()
              .from(evidenceTable)
              .where(eq(evidenceTable.id, ref.evidenceId));
            return row ? toEvidence(row) : undefined;
          }),
        resolve: (citation, jurisdiction, corpusVersion) =>
          citation.kind === 'decision'
            ? Promise.resolve(resolveDecision(decisions, citation, jurisdiction))
            : resolveCitation(
                connection,
                citation,
                jurisdiction,
                corpusVersion === undefined ? {} : { corpusVersion },
              ),
        ...(review ? { review } : {}),
        ...(options.now ? { now: options.now } : {}),
      };
      const verdict = await verifyClaim(claim, deps);
      await recordVerdict(connection, tenantId, claim, verdict);
      return verdict;
    },
  };
}

export interface ReviewQueueEntry {
  readonly id: string;
  readonly tenantId: string;
  readonly caseId: string;
  readonly claimId: string;
  readonly claimKind: string;
  readonly statement: string;
  readonly reason: string;
  readonly at: string;
}

// Rejections nobody has looked at, across tenants, newest first. Internal.
export async function reviewQueue(connection: Connection, limit = 50): Promise<ReviewQueueEntry[]> {
  const rows = await connection.sql<
    {
      id: string;
      tenant_id: string;
      case_id: string;
      claim_id: string;
      claim_kind: string;
      statement: string;
      reason: string;
      at: string | Date;
    }[]
  >`select * from review_queue(${limit})`;
  return rows.map((r) => ({
    id: r.id,
    tenantId: r.tenant_id,
    caseId: r.case_id,
    claimId: r.claim_id,
    claimKind: r.claim_kind,
    statement: r.statement,
    reason: r.reason,
    at: new Date(r.at).toISOString(),
  }));
}

export async function markReviewed(
  connection: Connection,
  tenantId: string,
  id: string,
  by: string,
  at: Date = new Date(),
): Promise<boolean> {
  return withTenant(connection, tenantId, async (tx) => {
    const rows = await tx
      .update(claimVerdicts)
      .set({ reviewedAt: at, reviewedBy: by })
      .where(and(eq(claimVerdicts.id, id), sql`${claimVerdicts.reviewedAt} is null`))
      .returning({ id: claimVerdicts.id });
    return rows.length === 1;
  });
}
