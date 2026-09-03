import { eq } from 'drizzle-orm';
import { ROLES, roleFor, type Role, type RoleFinding } from '@gc/findings';
import type { Connection } from './client.js';
import { cases, findings } from './schema.js';
import { withTenant } from './tenant.js';

// Shared progress (P-03): where the case stands, as numbers everyone on it may see.
// A count per desk says how much is open and done without saying what; the findings
// themselves stay behind each role's own list. Nothing here names a finding.

export interface RoleProgress {
  readonly role: Role;
  readonly open: number;
  readonly done: number;
}

export interface CaseProgress {
  readonly caseId: string;
  readonly stage: string;
  readonly roles: readonly RoleProgress[];
  readonly open: number;
  readonly done: number;
  // 0 to 100, done over everything; 100 when there was nothing to do.
  readonly percent: number;
}

export function progressFromFindings(
  caseId: string,
  stage: string,
  rows: readonly Pick<RoleFinding, 'typeId' | 'area' | 'status'>[],
): CaseProgress {
  const counts = new Map<Role, { open: number; done: number }>(
    ROLES.map((r) => [r, { open: 0, done: 0 }]),
  );
  for (const f of rows) {
    const c = counts.get(roleFor(f))!;
    if (f.status === 'closed') c.done += 1;
    else c.open += 1;
  }
  const roles = ROLES.map((role) => ({ role, ...counts.get(role)! }));
  const open = roles.reduce((n, r) => n + r.open, 0);
  const done = roles.reduce((n, r) => n + r.done, 0);
  const percent = open + done === 0 ? 100 : Math.round((100 * done) / (open + done));
  return { caseId, stage, roles, open, done, percent };
}

export async function caseProgress(
  connection: Connection,
  tenantId: string,
  caseId: string,
): Promise<CaseProgress> {
  return withTenant(connection, tenantId, async (db) => {
    const [c] = await db
      .select({ stage: cases.stage })
      .from(cases)
      .where(eq(cases.id, caseId))
      .limit(1);
    if (!c) throw new Error(`no case ${caseId}`);
    const rows = await db
      .select({ typeId: findings.typeId, area: findings.area, status: findings.status })
      .from(findings)
      .where(eq(findings.caseId, caseId));
    return progressFromFindings(
      caseId,
      c.stage,
      rows as Pick<RoleFinding, 'typeId' | 'area' | 'status'>[],
    );
  });
}
