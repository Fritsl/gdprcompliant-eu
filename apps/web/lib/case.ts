import 'server-only';
import { caseByToken, caseTimeline, connect, withTenant } from '@gc/db';
import type { CaseEvent } from '@gc/contracts';

// A case reached by its token (C-01): resolve the token, then read as that tenant.
// No database, no token match, or an expired case all come back as nothing found.

export interface CaseView {
  readonly caseId: string;
  readonly tenantId: string;
  readonly claimed: boolean;
  readonly events: CaseEvent[];
}

export async function loadCaseByToken(
  token: string,
  env: Record<string, string | undefined> = process.env,
): Promise<CaseView | undefined> {
  const url = env['DATABASE_URL'];
  if (!url) return undefined;
  const connection = connect(url, { max: 1 });
  try {
    const found = await caseByToken(connection, token);
    if (!found) return undefined;
    const events = await withTenant(connection, found.tenantId, (db) =>
      caseTimeline(db, found.caseId),
    );
    return { caseId: found.caseId, tenantId: found.tenantId, claimed: found.claimed, events };
  } finally {
    await connection.close();
  }
}
