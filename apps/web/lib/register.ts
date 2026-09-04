import 'server-only';
import { registerDocument, registerTerm } from '@gc/artefacts';
import type { Locale, RegisterRow } from '@gc/contracts';
import { caseByToken, caseCompany, confirmRegisterRow, registerRows } from '@gc/db';
import { holder, withConnection } from '@/lib/case';

// The processing register as the token's holder sees it (G-01, T-09): the rows the scan
// seeded, marked draft until a person confirms them, each read in the visitor's language
// from the register vocabulary; confirming a row is one form; the whole record downloads
// as the Article 30 document.

export interface RegisterRowView {
  readonly key: string;
  readonly activityId: string;
  readonly name: string;
  readonly draft: boolean;
  readonly purposes: readonly string[];
  readonly dataSubjects: readonly string[];
  readonly dataCategories: readonly string[];
  readonly legalBases: readonly string[];
  readonly recipients: readonly string[];
  readonly transfers: readonly string[];
  readonly retention?: string;
  readonly evidence: readonly string[];
  readonly contradictions: number;
}

export interface RegisterView {
  readonly caseId: string;
  readonly rows: readonly RegisterRowView[];
  readonly confirmed: number;
  readonly total: number;
}

function viewOf(row: RegisterRow, locale: Locale): RegisterRowView {
  const subjects = (row.attributes['dataSubjects'] as string[] | undefined) ?? [];
  const retention = row.attributes['retention'];
  return {
    key: row.key,
    activityId: row.activityId,
    name: registerTerm('activities', row.name, locale),
    draft: row.draft,
    purposes: row.purposes.map((p) => registerTerm('purposes', p, locale)),
    dataSubjects: subjects.map((s) => registerTerm('subjects', s, locale)),
    dataCategories: row.dataCategories.map((c) => registerTerm('categories', c, locale)),
    legalBases: row.legalBases.map((b) => registerTerm('bases', b, locale)),
    recipients: row.recipients.map((r) => (r.country ? `${r.name} (${r.country})` : r.name)),
    transfers: row.transfers.map((x) => {
      const statement = x.attributes['statement'] as Record<string, string> | undefined;
      return statement?.[locale] ?? statement?.['en'] ?? x.vendor;
    }),
    ...(typeof retention === 'string' && retention ? { retention } : {}),
    evidence: row.evidence.map((e) => e.evidenceId),
    contradictions: row.contradictions,
  };
}

export function loadRegister(token: string, locale: Locale): Promise<RegisterView | undefined> {
  return withConnection(async (connection) => {
    const found = await caseByToken(connection, token);
    if (!found) return undefined;
    const rows = await registerRows(connection, found.tenantId, found.caseId);
    const views = rows.map((r) => viewOf(r, locale));
    return {
      caseId: found.caseId,
      rows: views,
      confirmed: views.filter((r) => !r.draft).length,
      total: views.length,
    };
  });
}

export async function registerCounts(
  token: string,
): Promise<{ confirmed: number; total: number } | undefined> {
  const view = await loadRegister(token, 'en');
  return view ? { confirmed: view.confirmed, total: view.total } : undefined;
}

// The holder confirms a row, answering how long the data is kept as they do.
export async function confirmForOwner(
  token: string,
  activityId: string,
  input: { readonly retention?: string },
): Promise<boolean> {
  const done = await withConnection(async (connection) => {
    const found = await caseByToken(connection, token);
    if (!found) return false;
    const rows = await registerRows(connection, found.tenantId, found.caseId);
    const row = rows.find((r) => r.activityId === activityId);
    if (!row || !row.draft) return false;
    const retention = input.retention?.trim();
    await confirmRegisterRow(connection, found.tenantId, {
      caseId: found.caseId,
      activityId,
      answerId: `register:${row.key}`,
      by: holder(found.caseId).name,
      at: new Date(),
      ...(retention ? { corrections: { retention } } : {}),
    });
    return true;
  });
  return done ?? false;
}

export function registerMarkdownForOwner(
  token: string,
  locale: Locale,
): Promise<{ caseId: string; markdown: string } | undefined> {
  return withConnection(async (connection) => {
    const found = await caseByToken(connection, token);
    if (!found) return undefined;
    const company = await caseCompany(connection, found.tenantId, found.caseId);
    if (!company) return undefined;
    const rows = await registerRows(connection, found.tenantId, found.caseId);
    return {
      caseId: found.caseId,
      markdown: registerDocument({ rows, company, locale, generatedAt: new Date() }),
    };
  });
}
