import 'server-only';
import {
  RateLimited,
  attestFinding,
  caseByToken,
  caseCompany,
  caseProgress,
  caseSummary,
  caseTimeline,
  connect,
  deleteCase,
  evidencePack,
  exportCase,
  findingsWithEvidence,
  inviteMember,
  joinByInvite,
  listMembers,
  memberView,
  recordPackGenerated,
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
import { checkForMeProposal, type Role } from '@gc/findings';
import { localise } from '@gc/i18n';
import { JobQueue } from '@gc/jobs';
import { loadCatalogue } from '@gc/remedies';
import type {
  CaseEvent,
  Citation,
  FindingArea,
  Locale,
  LocalisedText,
  Remedy,
  TaskProposal,
} from '@gc/contracts';

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

// The evidence pack (G-04), dated now; handing one out is on the timeline afterwards.
export function packForToken(
  token: string,
  locale: Locale,
): Promise<{ caseId: string; zip: Uint8Array; sha256: string } | undefined> {
  return withConnection(async (connection) => {
    const found = await caseByToken(connection, token);
    if (!found) return undefined;
    const at = new Date();
    const pack = await evidencePack(connection, found.tenantId, found.caseId, { locale, at });
    await recordPackGenerated(connection, found.tenantId, found.caseId, pack, at);
    return { caseId: found.caseId, zip: pack.zip, sha256: pack.sha256 };
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

// ---- the case page (U-03) --------------------------------------------------------

export interface CaseEvidenceView {
  readonly id: string;
  readonly kind: string;
  readonly capturedAt: string;
  readonly caption: string | null;
  readonly hash: string;
  readonly body: string;
  readonly quote: string | null;
  readonly observedAt: string;
}

export type CaseActionView =
  | { readonly kind: 'agent_prompt'; readonly label: string; readonly body: string }
  | {
      readonly kind: 'message';
      readonly label: string;
      readonly to: string;
      readonly subject: string;
      readonly body: string;
    }
  | { readonly kind: 'link'; readonly label: string; readonly url: string };

export type VerifyMethod = Remedy['verification']['method'];

export interface CaseFindingView {
  readonly id: string;
  readonly typeId: string;
  readonly area: string;
  readonly severity: string;
  readonly open: boolean;
  readonly citations: string[];
  readonly authority?: string;
  readonly remedy: {
    readonly kind: string;
    readonly title: string;
    readonly effort: string;
    readonly minutes: number;
    readonly detail: string;
    readonly snippet?: string;
    readonly verifyLabel?: string;
    readonly verify: VerifyMethod;
    readonly action?: CaseActionView;
  };
  readonly evidence: CaseEvidenceView[];
}

export interface CasePageView extends CaseSummary {
  readonly members: MemberSummary[];
  readonly progress: CaseProgress;
  readonly domain: string;
  readonly findings: CaseFindingView[];
}

const DEFAULT_MINUTES = 15;

// A citation as the page shows it: the instrument and the reference the binding gave.
export function citationText(c: Citation): string {
  if (c.kind === 'provision') return `${c.instrument} ${c.ref}`;
  if (c.kind === 'decision') return `${c.body} ${c.reference}`;
  return `${c.authority}: ${c.title}`;
}

const pick = (text: LocalisedText | undefined, locale: Locale): string | undefined =>
  text ? localise(text, locale).value : undefined;

// Remedy text carries {{domain}}; the page fills it, nothing else.
const fill = (text: string, domain: string) => text.replaceAll('{{domain}}', domain);

function renderAction(
  action: Remedy['action'] | undefined,
  locale: Locale,
  domain: string,
): CaseActionView | undefined {
  if (!action) return undefined;
  const label = fill(localise(action.label, locale).value, domain);
  switch (action.kind) {
    case 'agent_prompt':
      return {
        kind: 'agent_prompt',
        label,
        body: fill(localise(action.body, locale).value, domain),
      };
    case 'message':
      return {
        kind: 'message',
        label,
        to: fill(localise(action.to, locale).value, domain),
        subject: fill(localise(action.subject, locale).value, domain),
        body: fill(localise(action.body, locale).value, domain),
      };
    case 'link':
      return { kind: 'link', label, url: action.url };
  }
}

function bindingOf(value: unknown): { citations: string[]; authority?: string } {
  const b = value as { citations?: Citation[]; authority?: { name?: string } } | null;
  const citations = Array.isArray(b?.citations) ? b.citations.map(citationText) : [];
  return b?.authority?.name ? { citations, authority: b.authority.name } : { citations };
}

export function loadCasePage(token: string, locale: Locale): Promise<CasePageView | undefined> {
  return withConnection(async (connection) => {
    const found = await caseByToken(connection, token);
    if (!found) return undefined;
    const summary = await caseSummary(connection, found.tenantId, found.caseId);
    const members = await listMembers(connection, found.tenantId, found.caseId, {
      baseUrl: appBaseUrl(),
      locale,
    });
    const progress = await caseProgress(connection, found.tenantId, found.caseId);
    const company = await caseCompany(connection, found.tenantId, found.caseId);
    const domain = company?.domain ?? '';
    const rows = await findingsWithEvidence(connection, found.tenantId, found.caseId);
    const findings = rows.map(({ finding, evidence }): CaseFindingView => {
      const entry = catalogue.get(finding.remedyId, finding.remedyVersion);
      const r = entry?.remedy;
      const snippet = r?.kind === 'self_fix' ? r.snippet : undefined;
      const action = renderAction(r && 'action' in r ? r.action : undefined, locale, domain);
      return {
        id: finding.id,
        typeId: finding.typeId,
        area: finding.area,
        severity: finding.severity,
        open: finding.status === 'open',
        ...bindingOf(finding.binding),
        remedy: {
          kind: r?.kind ?? 'no_solution',
          title: fill(pick(r?.title, locale) ?? finding.remedyId, domain),
          effort: pick(r?.effort.label, locale) ?? '',
          minutes: r?.effort.minutes ?? DEFAULT_MINUTES,
          detail: fill(pick(r?.detail, locale) ?? '', domain),
          ...(snippet ? { snippet: fill(snippet, domain) } : {}),
          ...(r?.verifyLabel ? { verifyLabel: localise(r.verifyLabel, locale).value } : {}),
          verify: r?.verification.method ?? 'none',
          ...(action ? { action } : {}),
        },
        evidence: evidence.map((e) => ({
          id: e.id,
          kind: e.kind,
          capturedAt: e.capturedAt.toISOString(),
          caption: e.caption,
          hash: e.hash,
          body: e.body,
          quote: e.quote,
          observedAt: observedAt(e.observed),
        })),
      };
    });
    return { ...summary, members, progress, domain, findings };
  });
}

const observedAt = (observed: unknown): string => {
  const o = observed as Record<string, unknown> | null;
  const parts = ['url', 'host', 'pass', 'registry', 'question']
    .map((k) => o?.[k])
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
  return parts.join(' · ');
};

// "Check it again": the same re-check a colleague can ask for (P-01), from the owner.
export async function checkForOwner(token: string, findingId: string): Promise<boolean> {
  const done = await withConnection(async (connection) => {
    const found = await caseByToken(connection, token);
    if (!found) return false;
    const rows = await findingsWithEvidence(connection, found.tenantId, found.caseId);
    const row = rows.find((r) => r.finding.id === findingId);
    const company = await caseCompany(connection, found.tenantId, found.caseId);
    if (!row || !company) return false;
    const url = process.env['DATABASE_URL'];
    if (!url) return false;
    const proposal = checkForMeProposal(
      { typeId: row.finding.typeId, area: row.finding.area as FindingArea },
      company.domain,
    );
    const queue = new JobQueue({ connectionString: url });
    await queue.start();
    try {
      await requestCheck(queue, proposal);
      return true;
    } finally {
      await queue.stop({ graceful: true });
    }
  });
  return done ?? false;
}

// "I have done this": only a remedy verified by attestation closes on the holder's word.
export async function attestForOwner(token: string, findingId: string): Promise<boolean> {
  const done = await withConnection(async (connection) => {
    const found = await caseByToken(connection, token);
    if (!found) return false;
    const rows = await findingsWithEvidence(connection, found.tenantId, found.caseId);
    const row = rows.find((r) => r.finding.id === findingId);
    if (!row || row.finding.status !== 'open') return false;
    const entry = catalogue.get(row.finding.remedyId, row.finding.remedyVersion);
    const v = entry?.remedy.verification;
    if (!v || v.method !== 'attestation') return false;
    await attestFinding(connection, found.tenantId, findingId, {
      by: { kind: 'person', userId: `token:${found.caseId}`, name: 'Case holder' },
      statement: v.statement,
    });
    return true;
  });
  return done ?? false;
}
