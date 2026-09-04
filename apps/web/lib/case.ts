import 'server-only';
import {
  PostgresDemandLedger,
  RECHECK_JOB,
  RateLimited,
  SignatureRequired,
  StaleSignature,
  artefactsForCase,
  attestFinding,
  caseByToken,
  caseCompany,
  caseProgress,
  caseSummary,
  caseTimeline,
  connect,
  createShare,
  deleteCase,
  evidencePack,
  exportArtefact,
  exportCase,
  findingsWithEvidence,
  inviteMember,
  joinByInvite,
  listMembers,
  listShares,
  memberView,
  publishArtefact,
  recheckStatus,
  recordPackGenerated,
  remindMember,
  requestCheck,
  revokeInvitation,
  revokeShare,
  shareByToken,
  publishTrustPage,
  signArtefact,
  trustPage,
  trustStatus,
  unpublishTrustPage,
  withTenant,
  type CaseProgress,
  type CaseSummary,
  type Connection,
  type DeletionStub,
  type ExportedArtefact,
  type MemberSummary,
  type MemberView,
  type RecheckProgress,
  type ShareSummary,
  type TrustStatus,
} from '@gc/db';
import type { Role } from '@gc/findings';
import { localise } from '@gc/i18n';
import { JobQueue } from '@gc/jobs';
import { loadCatalogue } from '@gc/remedies';
import type {
  ArtefactKind,
  CaseEvent,
  Citation,
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
      // And the real re-check of that finding (U-04, T-09), in the colleague's name.
      await queue.enqueue(RECHECK_JOB, {
        tenantId: view.member.tenantId,
        caseId: view.member.caseId,
        findingId,
        requestedBy: {
          kind: 'person',
          userId: `member:${view.member.memberId}`,
          name: invite.slice(0, 8),
        },
      });
      return true;
    } finally {
      await queue.stop({ graceful: true });
    }
  });
  return done ?? false;
}

// ---- the case page (U-03, U-04) --------------------------------------------------

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
  | {
      readonly kind: 'agent_prompt';
      readonly label: string;
      readonly body: string;
      readonly forwardable?: string;
    }
  | {
      readonly kind: 'message';
      readonly label: string;
      readonly to: string;
      readonly subject: string;
      readonly body: string;
    }
  | { readonly kind: 'link'; readonly label: string; readonly url: string };

export type VerifyMethod = Remedy['verification']['method'];
export type RemedyKind = Remedy['kind'];

export interface CaseRemedyView {
  readonly kind: RemedyKind;
  readonly title: string;
  readonly effort: string;
  readonly minutes: number;
  readonly detail: string;
  readonly snippet?: string;
  readonly verifyLabel?: string;
  readonly verify: VerifyMethod;
  readonly action?: CaseActionView;
  readonly cta?: string;
  readonly artefact?: ArtefactKind;
  readonly product?: { readonly id: string; readonly url: string };
  readonly alternativeNote?: string;
  readonly options?: readonly {
    readonly name: string;
    readonly jurisdiction: string;
    readonly note?: string;
    readonly url?: string;
  }[];
  readonly askLabel?: string;
}

export interface CaseFindingView {
  readonly id: string;
  readonly typeId: string;
  readonly area: string;
  readonly severity: string;
  readonly status: string;
  readonly open: boolean;
  readonly closedAt?: string;
  readonly citations: string[];
  readonly authority?: string;
  readonly guideId?: string;
  readonly remedy: CaseRemedyView;
  readonly evidence: CaseEvidenceView[];
}

export interface CasePageView extends CaseSummary {
  readonly members: MemberSummary[];
  readonly progress: CaseProgress;
  readonly domain: string;
  readonly findings: CaseFindingView[];
  readonly trust: TrustStatus;
  readonly shares: ShareSummary[];
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
    case 'agent_prompt': {
      const forwardable = pick(action.forwardable, locale);
      return {
        kind: 'agent_prompt',
        label,
        body: fill(localise(action.body, locale).value, domain),
        ...(forwardable ? { forwardable: fill(forwardable, domain) } : {}),
      };
    }
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

function renderRemedy(
  r: Remedy | undefined,
  fallbackId: string,
  locale: Locale,
  domain: string,
): CaseRemedyView {
  const action = renderAction(r && 'action' in r ? r.action : undefined, locale, domain);
  const view: CaseRemedyView = {
    kind: r?.kind ?? 'no_solution',
    title: fill(pick(r?.title, locale) ?? fallbackId, domain),
    effort: pick(r?.effort.label, locale) ?? '',
    minutes: r?.effort.minutes ?? DEFAULT_MINUTES,
    detail: fill(pick(r?.detail, locale) ?? '', domain),
    verify: r?.verification.method ?? 'none',
    ...(r?.verifyLabel ? { verifyLabel: localise(r.verifyLabel, locale).value } : {}),
    ...(action ? { action } : {}),
  };
  if (!r) return view;
  switch (r.kind) {
    case 'self_fix':
      return { ...view, ...(r.snippet ? { snippet: fill(r.snippet, domain) } : {}) };
    case 'generated_artefact':
      return { ...view, cta: localise(r.cta, locale).value, artefact: r.artefact };
    case 'our_product': {
      const note = pick(r.alternativeNote, locale);
      return {
        ...view,
        cta: localise(r.cta, locale).value,
        product: r.product,
        ...(note ? { alternativeNote: note } : {}),
      };
    }
    case 'partner_alternative':
      return {
        ...view,
        options: r.options.map((o) => {
          const note = pick(o.note, locale);
          return {
            name: o.name,
            jurisdiction: o.jurisdiction,
            ...(note ? { note } : {}),
            ...(o.url ? { url: o.url } : {}),
          };
        }),
      };
    case 'no_solution': {
      const ask = pick(r.askLabel, locale);
      return { ...view, ...(ask ? { askLabel: ask } : {}) };
    }
  }
}

function bindingOf(value: unknown): {
  citations: string[];
  authority?: string;
  guideId?: string;
} {
  const b = value as {
    citations?: Citation[];
    authority?: { name?: string };
    guideId?: string;
  } | null;
  const citations = Array.isArray(b?.citations) ? b.citations.map(citationText) : [];
  return {
    citations,
    ...(b?.authority?.name ? { authority: b.authority.name } : {}),
    ...(b?.guideId ? { guideId: b.guideId } : {}),
  };
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
      return {
        id: finding.id,
        typeId: finding.typeId,
        area: finding.area,
        severity: finding.severity,
        status: finding.status,
        open: finding.status === 'open' || finding.status === 'regressed',
        ...(finding.closedAt ? { closedAt: finding.closedAt.toISOString() } : {}),
        ...bindingOf(finding.binding),
        remedy: renderRemedy(entry?.remedy, finding.remedyId, locale, domain),
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
    const trust = await trustStatus(connection, found.tenantId, found.caseId);
    const shares = await listShares(connection, found.tenantId, found.caseId, {
      baseUrl: appBaseUrl(),
      locale,
    });
    return { ...summary, members, progress, domain, findings, trust, shares };
  });
}

const observedAt = (observed: unknown): string => {
  const o = observed as Record<string, unknown> | null;
  const parts = ['url', 'host', 'pass', 'registry', 'question']
    .map((k) => o?.[k])
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
  return parts.join(' · ');
};

// The token's holder as an actor: a person, named by the case they hold.
const holder = (caseId: string, name = 'Case holder') => ({
  kind: 'person' as const,
  userId: `token:${caseId}`,
  name,
});

async function findingForOwner(connection: Connection, token: string, findingId: string) {
  const found = await caseByToken(connection, token);
  if (!found) return undefined;
  const rows = await findingsWithEvidence(connection, found.tenantId, found.caseId);
  const row = rows.find((r) => r.finding.id === findingId);
  if (!row) return undefined;
  return { found, row, entry: catalogue.get(row.finding.remedyId, row.finding.remedyVersion) };
}

// "Check it again" (U-04): a re-check job for the worker; the page reads the job back.
export async function checkForOwner(token: string, findingId: string): Promise<string | undefined> {
  return withConnection(async (connection) => {
    const hit = await findingForOwner(connection, token, findingId);
    if (!hit || hit.row.finding.status === 'closed') return undefined;
    const url = process.env['DATABASE_URL'];
    if (!url) return undefined;
    const queue = new JobQueue({ connectionString: url });
    await queue.start();
    try {
      return await queue.enqueue(RECHECK_JOB, {
        tenantId: hit.found.tenantId,
        caseId: hit.found.caseId,
        findingId,
        requestedBy: holder(hit.found.caseId),
      });
    } finally {
      await queue.stop({ graceful: true });
    }
  });
}

export interface RecheckView {
  readonly id: string;
  readonly findingId: string;
  readonly state: string;
  readonly progress?: RecheckProgress;
}

// A re-check is read only by the case it belongs to.
export async function readRecheck(token: string, jobId: string): Promise<RecheckView | undefined> {
  return withConnection(async (connection) => {
    const found = await caseByToken(connection, token);
    if (!found) return undefined;
    const url = process.env['DATABASE_URL'];
    if (!url) return undefined;
    const queue = new JobQueue({ connectionString: url });
    await queue.start();
    try {
      const status = await recheckStatus(queue, jobId);
      if (!status || status.payload.caseId !== found.caseId) return undefined;
      return {
        id: jobId,
        findingId: status.payload.findingId,
        state: status.state,
        ...(status.progress ? { progress: status.progress } : {}),
      };
    } finally {
      await queue.stop({ graceful: true });
    }
  });
}

// "I have done this": only a remedy verified by attestation closes on the holder's word.
export async function attestForOwner(token: string, findingId: string): Promise<boolean> {
  const done = await withConnection(async (connection) => {
    const hit = await findingForOwner(connection, token, findingId);
    if (!hit || hit.row.finding.status === 'closed') return false;
    const v = hit.entry?.remedy.verification;
    if (!v || v.method !== 'attestation') return false;
    await attestFinding(connection, hit.found.tenantId, findingId, {
      by: holder(hit.found.caseId),
      statement: v.statement,
    });
    return true;
  });
  return done ?? false;
}

// "Ask for an answer" on a no_solution remedy (R-05): one row in the demand ledger.
export async function askForOwner(token: string, findingId: string): Promise<boolean> {
  const done = await withConnection(async (connection) => {
    const hit = await findingForOwner(connection, token, findingId);
    if (!hit) return false;
    const r = hit.entry?.remedy;
    if (!r || r.kind !== 'no_solution') return false;
    const company = await caseCompany(connection, hit.found.tenantId, hit.found.caseId);
    if (!company) return false;
    await withTenant(connection, hit.found.tenantId, (db) =>
      new PostgresDemandLedger(db, hit.found.tenantId, { country: company.country }).record({
        findingTypeId: hit.row.finding.typeId,
        jurisdiction: hit.row.finding.jurisdiction,
        caseId: hit.found.caseId,
        gap: r.demandGap,
        cause: 'asked from the case page',
        answer: 'none',
      }),
    );
    return true;
  });
  return done ?? false;
}

// ---- generated documents: preview, sign, publish, export (U-04, A-09) ----------------

export interface ArtefactView {
  readonly caseId: string;
  readonly kind: ArtefactKind;
  readonly document?: {
    readonly id: string;
    readonly version: number;
    readonly hash: string;
    readonly status: string;
    readonly content: string;
    readonly generatedAt: string;
    readonly signedBy?: string;
    readonly signedAt?: string;
    readonly publishedAt?: string;
    readonly publishedUrl?: string;
  };
}

async function artefactRow(connection: Connection, token: string, kind: ArtefactKind) {
  const found = await caseByToken(connection, token);
  if (!found) return undefined;
  const rows = await artefactsForCase(connection, found.tenantId, found.caseId);
  return { found, row: rows.find((r) => r.kind === kind) };
}

export async function loadArtefact(
  token: string,
  kind: ArtefactKind,
): Promise<ArtefactView | undefined> {
  return withConnection(async (connection) => {
    const hit = await artefactRow(connection, token, kind);
    if (!hit) return undefined;
    const row = hit.row;
    if (!row) return { caseId: hit.found.caseId, kind };
    const signer = row.signedBy as { name?: string } | null;
    return {
      caseId: hit.found.caseId,
      kind,
      document: {
        id: row.id,
        version: row.version,
        hash: row.hash,
        status: row.status,
        content: row.content,
        generatedAt: row.generatedAt.toISOString(),
        ...(signer?.name ? { signedBy: signer.name } : {}),
        ...(row.signedAt ? { signedAt: row.signedAt.toISOString() } : {}),
        ...(row.publishedAt ? { publishedAt: row.publishedAt.toISOString() } : {}),
        ...(row.publishedUrl ? { publishedUrl: row.publishedUrl } : {}),
      },
    };
  });
}

export type SignOutcome = 'ok' | 'stale' | 'invalid' | 'not_found';

// A person signs the version and the bytes they read; anything else is stale.
export async function signForOwner(
  token: string,
  kind: ArtefactKind,
  input: { readonly name: string; readonly version: number; readonly hash: string },
): Promise<SignOutcome> {
  const outcome = await withConnection(async (connection): Promise<SignOutcome> => {
    const hit = await artefactRow(connection, token, kind);
    if (!hit?.row) return 'not_found';
    const name = input.name.trim();
    if (name.length === 0 || name.length > 80) return 'invalid';
    try {
      await signArtefact(connection, hit.found.tenantId, hit.row.id, {
        by: holder(hit.found.caseId, name),
        version: input.version,
        hash: input.hash,
      });
      return 'ok';
    } catch (e) {
      if (e instanceof StaleSignature) return 'stale';
      throw e;
    }
  });
  return outcome ?? 'not_found';
}

export type PublishOutcome = 'ok' | 'unsigned' | 'invalid' | 'not_found';

export async function publishForOwner(
  token: string,
  kind: ArtefactKind,
  input: { readonly url?: string },
): Promise<PublishOutcome> {
  const outcome = await withConnection(async (connection): Promise<PublishOutcome> => {
    const hit = await artefactRow(connection, token, kind);
    if (!hit?.row) return 'not_found';
    let url: string | undefined;
    if (input.url && input.url.trim().length > 0) {
      try {
        const parsed = new URL(input.url.trim());
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return 'invalid';
        url = parsed.toString();
      } catch {
        return 'invalid';
      }
    }
    try {
      await publishArtefact(connection, hit.found.tenantId, hit.row.id, {
        by: holder(hit.found.caseId),
        ...(url ? { url } : {}),
      });
      return 'ok';
    } catch (e) {
      if (e instanceof SignatureRequired) return 'unsigned';
      throw e;
    }
  });
  return outcome ?? 'not_found';
}

export async function exportArtefactForOwner(
  token: string,
  kind: ArtefactKind,
): Promise<ExportedArtefact | undefined> {
  return withConnection(async (connection) => {
    const hit = await artefactRow(connection, token, kind);
    if (!hit?.row) return undefined;
    try {
      return await exportArtefact(connection, hit.found.tenantId, hit.row.id);
    } catch (e) {
      if (e instanceof SignatureRequired) return undefined;
      throw e;
    }
  });
}

// ---- the public progress page (U-05) --------------------------------------------------

export type TrustToggle = 'published' | 'already' | 'unpublished' | 'not_published';

export async function publishTrustForOwner(token: string): Promise<TrustToggle | undefined> {
  return withConnection(async (connection) => {
    const found = await caseByToken(connection, token);
    if (!found) return undefined;
    const result = await publishTrustPage(connection, found.tenantId, found.caseId, {
      by: holder(found.caseId),
    });
    return result.already ? 'already' : 'published';
  });
}

export async function unpublishTrustForOwner(token: string): Promise<TrustToggle | undefined> {
  return withConnection(async (connection) => {
    const found = await caseByToken(connection, token);
    if (!found) return undefined;
    const done = await unpublishTrustPage(connection, found.tenantId, found.caseId, {
      by: holder(found.caseId),
    });
    return done ? 'unpublished' : 'not_published';
  });
}

export interface TrustFixedView {
  readonly findingId: string;
  readonly title: string;
  readonly closedAt: string;
}

export interface TrustPageViewLocalised {
  readonly caseId: string;
  readonly domain: string;
  readonly name: string;
  readonly publishedAt: string;
  readonly lastCheckedAt?: string;
  readonly openCount: number;
  readonly fixed: TrustFixedView[];
}

// What anyone may see: fixed items by their remedy's title, dated; a count of what is
// open; when we last looked. The finding ids are the case's own and stay inside.
export async function loadTrustPage(
  slug: string,
  locale: Locale,
): Promise<TrustPageViewLocalised | undefined> {
  return withConnection(async (connection) => {
    const view = await trustPage(connection, slug);
    if (!view) return undefined;
    const domain = view.company.domain;
    return {
      caseId: view.caseId,
      domain,
      name: view.company.legalName ?? domain,
      publishedAt: view.publishedAt.toISOString(),
      ...(view.lastCheckedAt ? { lastCheckedAt: view.lastCheckedAt.toISOString() } : {}),
      openCount: view.openCount,
      fixed: view.fixed.map((f) => {
        const entry = catalogue.get(f.remedyId, f.remedyVersion);
        return {
          findingId: f.findingId,
          title: fill(pick(entry?.remedy.title, locale) ?? f.remedyId, domain),
          closedAt: f.closedAt.toISOString(),
        };
      }),
    };
  });
}

// ---- upward sharing (U-07) --------------------------------------------------------------

// A summary link, in the holder's hands to give and to take back.
export async function createShareForOwner(
  token: string,
  audience: string,
): Promise<string | undefined> {
  return withConnection(async (connection) => {
    const found = await caseByToken(connection, token);
    if (!found) return undefined;
    const created = await createShare(connection, found.tenantId, found.caseId, {
      audience,
      by: holder(found.caseId),
    });
    return created.shareId;
  });
}

export async function revokeShareForOwner(token: string, shareId: string): Promise<boolean> {
  const done = await withConnection(async (connection) => {
    const found = await caseByToken(connection, token);
    if (!found) return false;
    return revokeShare(connection, found.tenantId, found.caseId, shareId, {
      by: holder(found.caseId),
    });
  });
  return done ?? false;
}

export interface UpwardView {
  readonly caseId: string;
  readonly domain: string;
  readonly audience: string;
  readonly done: number;
  readonly open: number;
  readonly openBySeverity: Readonly<Record<'blocking' | 'serious' | 'advisory', number>>;
  readonly roles: readonly { role: Role; open: number; done: number }[];
  readonly fixed: TrustFixedView[];
  readonly lastCheckedAt?: string;
  readonly generatedAt: string;
}

// One screen for someone above the case: progress by desk and by weight, what was fixed
// and when. Read through the share link, which is the reader's only key.
export async function loadUpward(
  shareToken: string,
  locale: Locale,
): Promise<UpwardView | undefined> {
  return withConnection(async (connection) => {
    const share = await shareByToken(connection, shareToken);
    if (!share) return undefined;
    const company = await caseCompany(connection, share.tenantId, share.caseId);
    const progress = await caseProgress(connection, share.tenantId, share.caseId);
    const rows = await findingsWithEvidence(connection, share.tenantId, share.caseId);
    const events = await withTenant(connection, share.tenantId, (db) =>
      caseTimeline(db, share.caseId),
    );
    const domain = company?.domain ?? '';
    const openBySeverity = { blocking: 0, serious: 0, advisory: 0 };
    const fixed: TrustFixedView[] = [];
    for (const { finding } of rows) {
      if (finding.status === 'closed') {
        const entry = catalogue.get(finding.remedyId, finding.remedyVersion);
        fixed.push({
          findingId: finding.id,
          title: fill(pick(entry?.remedy.title, locale) ?? finding.remedyId, domain),
          closedAt: (finding.closedAt ?? finding.lastSeenAt).toISOString(),
        });
      } else if (finding.severity in openBySeverity) {
        openBySeverity[finding.severity as keyof typeof openBySeverity] += 1;
      }
    }
    fixed.sort((a, b) => b.closedAt.localeCompare(a.closedAt));
    const lastChecked = events
      .filter((e) => e.type === 'scan_completed')
      .map((e) => e.at)
      .sort()
      .at(-1);
    return {
      caseId: share.caseId,
      domain,
      audience: share.audience,
      done: progress.done,
      open: progress.open,
      openBySeverity,
      roles: progress.roles.map((r) => ({ role: r.role, open: r.open, done: r.done })),
      fixed,
      ...(lastChecked ? { lastCheckedAt: lastChecked } : {}),
      generatedAt: new Date().toISOString(),
    };
  });
}
