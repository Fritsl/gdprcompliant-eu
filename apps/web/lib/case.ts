import 'server-only';
import {
  RateLimited,
  caseByToken,
  caseProgress,
  caseSummary,
  caseTimeline,
  connect,
  deleteCase,
  exportCase,
  inviteMember,
  joinByInvite,
  listMembers,
  memberView,
  remindMember,
  requestCheck,
  revokeInvitation,
  withTenant,
  type CaseProgress,
  type CaseSummary,
  type Connection,
  type DeletionStub,
  type MemberSummary,
  type MemberView,
} from '@gc/db';
import type { Role } from '@gc/findings';
import { JobQueue } from '@gc/jobs';
import { loadCatalogue } from '@gc/remedies';
import type { CaseEvent, Locale, TaskProposal } from '@gc/contracts';

// The schema to read from, when a test points the app at a disposable one. Production
// leaves it unset and reads public.
export const searchPath = (env: Record<string, string | undefined>): { searchPath?: string[] } => {
  const path = env['GC_SEARCH_PATH'];
  return path ? { searchPath: path.split(',') } : {};
};

export const appBaseUrl = (env: Record<string, string | undefined> = process.env): string =>
  env['APP_BASE_URL'] ?? 'http://localhost:3000';

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
  const connection = connect(url, { max: 1, ...searchPath(env) });
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

export function loadCaseSummary(
  token: string,
  locale: Locale,
): Promise<(CaseSummary & { members: MemberSummary[]; progress: CaseProgress }) | undefined> {
  return withConnection(async (connection) => {
    const found = await caseByToken(connection, token);
    if (!found) return undefined;
    const summary = await caseSummary(connection, found.tenantId, found.caseId);
    const members = await listMembers(connection, found.tenantId, found.caseId, {
      baseUrl: appBaseUrl(),
      locale,
    });
    const progress = await caseProgress(connection, found.tenantId, found.caseId);
    return { ...summary, members, progress };
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

// ---- colleagues (P-02) -------------------------------------------------------------

export type ColleagueOutcome = 'ok' | 'rate_limited' | 'reminded' | 'invalid' | 'not_found';

export async function inviteForToken(
  token: string,
  input: { role: Role; email: string; from: string; locale: Locale },
): Promise<ColleagueOutcome> {
  const outcome = await withConnection(async (connection): Promise<ColleagueOutcome> => {
    const found = await caseByToken(connection, token);
    if (!found) return 'not_found';
    try {
      await inviteMember(connection, {
        caseId: found.caseId,
        tenantId: found.tenantId,
        role: input.role,
        email: input.email,
        invitedBy: input.from,
        baseUrl: appBaseUrl(),
        locale: input.locale,
      });
      return 'ok';
    } catch (e) {
      if (e instanceof RateLimited) return 'rate_limited';
      console.error('invite failed', e);
      return 'invalid';
    }
  });
  return outcome ?? 'not_found';
}

export async function remindForToken(
  token: string,
  memberId: string,
  locale: Locale,
): Promise<ColleagueOutcome> {
  const outcome = await withConnection(async (connection): Promise<ColleagueOutcome> => {
    const found = await caseByToken(connection, token);
    if (!found) return 'not_found';
    try {
      await remindMember(
        connection,
        { tenantId: found.tenantId, caseId: found.caseId, memberId },
        { baseUrl: appBaseUrl(), locale },
      );
      return 'ok';
    } catch (e) {
      return e instanceof RateLimited ? 'reminded' : 'invalid';
    }
  });
  return outcome ?? 'not_found';
}

export async function revokeForToken(token: string, memberId: string): Promise<ColleagueOutcome> {
  const outcome = await withConnection(async (connection): Promise<ColleagueOutcome> => {
    const found = await caseByToken(connection, token);
    if (!found) return 'not_found';
    try {
      await revokeInvitation(connection, {
        tenantId: found.tenantId,
        caseId: found.caseId,
        memberId,
      });
      return 'ok';
    } catch {
      return 'invalid';
    }
  });
  return outcome ?? 'not_found';
}

// ---- the colleague's own list ------------------------------------------------------

const catalogue = loadCatalogue();
const remedyOf = (id: string) => {
  const entry = catalogue.get(id);
  return {
    kind: entry?.remedy.kind ?? ('no_solution' as const),
    title: entry?.remedy.title.en ?? id,
  };
};

// First visit joins; every visit shows the list. No account anywhere.
export function loadMemberList(
  invite: string,
  locale: Locale,
): Promise<(MemberView & { progress: CaseProgress }) | undefined> {
  return withConnection(async (connection) => {
    const joined = await joinByInvite(connection, invite);
    if (!joined) return undefined;
    const view = await memberView(connection, invite, { locale, remedy: remedyOf });
    if (!view) return undefined;
    const progress = await caseProgress(connection, joined.tenantId, joined.caseId);
    return { ...view, progress };
  });
}

export async function checkForMember(
  invite: string,
  findingId: string,
  locale: Locale,
): Promise<boolean> {
  const done = await withConnection(async (connection) => {
    const view = await memberView(connection, invite, { locale, remedy: remedyOf });
    const item = view?.lists.flatMap((l) => l.items).find((i) => i.findingId === findingId);
    if (!view || !item) return false;
    const url = process.env['DATABASE_URL'];
    if (!url) return false;
    const queue = new JobQueue({ connectionString: url });
    await queue.start();
    try {
      await requestCheck(queue, item.checkForMe.proposal as TaskProposal);
      return true;
    } finally {
      await queue.stop({ graceful: true });
    }
  });
  return done ?? false;
}
