import 'server-only';
import {
  caseByToken,
  caseSummary,
  caseTimeline,
  connect,
  deleteCase,
  exportCase,
  withTenant,
  type CaseSummary,
  type Connection,
  type DeletionStub,
} from '@gc/db';
import type { CaseEvent, Locale } from '@gc/contracts';

// A case reached by its token (C-01): resolve the token, then act as that tenant.
// No database, no token match, or an expired case all come back as nothing found.

export interface CaseView {
  readonly caseId: string;
  readonly tenantId: string;
  readonly claimed: boolean;
  readonly events: CaseEvent[];
}

async function withConnection<T>(
  work: (connection: Connection) => Promise<T>,
  env: Record<string, string | undefined> = process.env,
): Promise<T | undefined> {
  const url = env['DATABASE_URL'];
  if (!url) return undefined;
  const connection = connect(url, { max: 1 });
  try {
    return await work(connection);
  } finally {
    await connection.close();
  }
}

export function loadCaseByToken(token: string): Promise<CaseView | undefined> {
  return withConnection(async (connection) => {
    const found = await caseByToken(connection, token);
    if (!found) return undefined;
    const events = await withTenant(connection, found.tenantId, (db) =>
      caseTimeline(db, found.caseId),
    );
    return { caseId: found.caseId, tenantId: found.tenantId, claimed: found.claimed, events };
  });
}

export function loadCaseSummary(token: string): Promise<CaseSummary | undefined> {
  return withConnection(async (connection) => {
    const found = await caseByToken(connection, token);
    if (!found) return undefined;
    return caseSummary(connection, found.tenantId, found.caseId);
  });
}

export function exportForToken(
  token: string,
  locale: Locale,
): Promise<{ caseId: string; json: string; sha256: string } | undefined> {
  return withConnection(async (connection) => {
    const found = await caseByToken(connection, token);
    if (!found) return undefined;
    const result = await exportCase(connection, found.tenantId, found.caseId, { locale });
    return { caseId: found.caseId, json: result.json, sha256: result.sha256 };
  });
}

// The case number typed back is the confirmation; a mismatch deletes nothing.
export function deleteForToken(token: string, confirm: string): Promise<DeletionStub | undefined> {
  return withConnection(async (connection) => {
    const found = await caseByToken(connection, token);
    if (!found || found.caseId !== confirm) return undefined;
    return deleteCase(connection, found.tenantId, found.caseId, {
      requestedBy: found.claimed ? 'owner' : 'token',
    });
  });
}
