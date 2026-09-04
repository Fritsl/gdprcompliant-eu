import { and, eq } from 'drizzle-orm';
import {
  agreementGaps,
  cookieDeclarationDocument,
  policyGaps,
  cookieGaps,
  privacyPolicyDocument,
  processingAgreementDocument,
  subProcessorGaps,
  subProcessorListDocument,
  type ContactAnswers,
  type DocumentGap,
  type GeneratedDocument,
  type ObservedCookie,
  type ProcessorInput,
  type SubProcessorRow,
} from '@gc/artefacts';
import {
  CompanySchema,
  type Actor,
  type ArtefactKind,
  type Locale,
  type RegisterRow,
} from '@gc/contracts';
import {
  classifyCookie,
  loadBindingTables,
  loadCookieDatabase,
  type CookieDatabase,
} from '@gc/findings';
import { generateArtefact, type GeneratedArtefact } from './artefacts.js';
import type { Connection, Db } from './client.js';
import { graphOf, registerProjection, type CaseGraph } from './graph.js';
import { answers, cases, evidence } from './schema.js';
import { withTenant } from './tenant.js';

// Generated documents (G-02, G-03): the privacy policy, the cookie declaration, the
// processing agreement and the sub-processor page, written from the case graph, the
// answers, the cookies read from the site and the supply chain the walk read. The gaps are
// computed the same way the document is, so a page can say what is missing before
// anyone presses the button, and a refusal names the same gaps.

export const GENERATED_KINDS = [
  'privacy_policy',
  'cookie_declaration',
  'processing_agreement',
  'sub_processor_list',
] as const;
export type GeneratedKind = (typeof GENERATED_KINDS)[number];
export const isGeneratedKind = (k: string): k is GeneratedKind =>
  (GENERATED_KINDS as readonly string[]).includes(k);

// The questions the policy needs answered, by id.
export const CONTACT_QUESTIONS = {
  address: 'controller.address',
  email: 'controller.email',
  dpo: 'controller.dpo',
} as const;

export async function recordAnswer(
  connection: Connection,
  tenantId: string,
  input: { caseId: string; questionId: string; answer: string; by: Actor; at: Date },
): Promise<void> {
  await withTenant(connection, tenantId, (db) =>
    db
      .insert(answers)
      .values({
        id: `answer:${input.caseId}:${input.questionId}`,
        tenantId,
        sourceRef: `answer:${input.questionId}`,
        caseId: input.caseId,
        questionId: input.questionId,
        answer: input.answer,
        answeredBy: input.by,
        answeredAt: input.at,
      })
      .onConflictDoUpdate({
        target: [answers.caseId, answers.questionId],
        set: { answer: input.answer, answeredBy: input.by, answeredAt: input.at },
      }),
  );
}

async function contactOf(db: Db, caseId: string): Promise<ContactAnswers> {
  const rows = await db.select().from(answers).where(eq(answers.caseId, caseId));
  const get = (q: string) => rows.find((r) => r.questionId === q);
  const address = get(CONTACT_QUESTIONS.address);
  const email = get(CONTACT_QUESTIONS.email);
  const dpo = get(CONTACT_QUESTIONS.dpo);
  return {
    ...(address?.answer ? { address: address.answer } : {}),
    ...(email?.answer ? { email: email.answer } : {}),
    ...(dpo?.answer ? { dpo: dpo.answer } : {}),
    trace: [address, email, dpo].filter((r) => r !== undefined).map((r) => r.id),
  };
}

let cookieDb: CookieDatabase | undefined;
const cookies = () => (cookieDb ??= loadCookieDatabase());

// The cookies the first load set, as evidence rows, classified against the database.
async function cookiesOf(
  db: Db,
  caseId: string,
  database: CookieDatabase,
): Promise<ObservedCookie[]> {
  const rows = await db
    .select()
    .from(evidence)
    .where(and(eq(evidence.caseId, caseId), eq(evidence.kind, 'cookie')));
  const seen = new Map<string, ObservedCookie>();
  for (const r of rows) {
    const c = JSON.parse(r.body) as { name: string; domain: string; expires: number };
    const key = `${c.name}@${c.domain}`;
    if (seen.has(key)) continue;
    const capturedAt = new Date(r.capturedAt).getTime() / 1000;
    const maxAge = c.expires > 0 ? Math.round(c.expires - capturedAt) : undefined;
    seen.set(key, {
      name: c.name,
      domain: c.domain,
      ...(maxAge !== undefined && maxAge > 0 ? { maxAgeSeconds: maxAge } : {}),
      classification: classifyCookie(database, {
        name: c.name,
        domain: c.domain.replace(/^\./, ''),
      }),
      evidenceId: r.id,
    });
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// The suppliers the confirmed register names as recipients (G-03), each with the
// activities that share data with it. The graph key is carried so the supply chain the
// walk wrote (D-07) can be matched to the same supplier.
function processorsOf(rows: readonly RegisterRow[], graph: CaseGraph): ProcessorInput[] {
  const keys = new Map(graph.nodes.map((n) => [n.id, n.key]));
  const byKey = new Map<
    string,
    { nodeId: string; key: string; name: string; country?: string; activities: RegisterRow[] }
  >();
  for (const r of rows) {
    if (r.draft) continue;
    for (const x of r.recipients) {
      const key = keys.get(x.nodeId) ?? x.nodeId;
      const p = byKey.get(key) ?? {
        nodeId: x.nodeId,
        key,
        name: x.name,
        ...(x.country ? { country: x.country } : {}),
        activities: [],
      };
      if (!p.activities.some((a) => a.activityId === r.activityId)) p.activities.push(r);
      byKey.set(key, p);
    }
  }
  return [...byKey.values()];
}

// The supply chain as the graph holds it (D-07): every engages edge that is not a
// cycle, with the company it names, who engaged it, and the list it was read from.
function subProcessorsOf(graph: CaseGraph): SubProcessorRow[] {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const text = (v: unknown) => (typeof v === 'string' ? v : undefined);
  return graph.edges
    .filter((e) => e.kind === 'engages' && e.attributes['cycle'] !== true)
    .flatMap((e) => {
      const from = nodes.get(e.from);
      const to = nodes.get(e.to);
      if (!from || !to || from.supersededBy || to.supersededBy) return [];
      const a = to.attributes;
      const country = text(a['country']);
      const purpose = text(e.attributes['purpose']);
      return [
        {
          nodeId: to.id,
          name: text(a['name']) ?? to.key,
          ...(country ? { country } : {}),
          engagedBy: {
            nodeId: from.id,
            name: text(from.attributes['name']) ?? from.key,
            key: from.key,
          },
          ...(purpose ? { purpose } : {}),
          source: text(e.attributes['document']) ?? '',
          readOn: text(e.attributes['fetchedAt']) ?? e.at,
          evidenceId: e.evidence[0]?.evidenceId ?? e.id,
          level: typeof a['level'] === 'number' ? a['level'] : 2,
        },
      ];
    });
}

interface CaseFrame {
  readonly locale: Locale;
  readonly jurisdiction: string;
  readonly company: ReturnType<typeof CompanySchema.parse>;
}

async function frameOf(db: Db, caseId: string): Promise<CaseFrame> {
  const [row] = await db
    .select({ locale: cases.locale, jurisdiction: cases.jurisdiction, company: cases.company })
    .from(cases)
    .where(eq(cases.id, caseId))
    .limit(1);
  if (!row) throw new Error(`no case ${caseId}`);
  return {
    locale: row.locale as Locale,
    jurisdiction: row.jurisdiction,
    company: CompanySchema.parse(row.company),
  };
}

function authorityOf(jurisdiction: string): { name: string; url?: string } {
  const table = loadBindingTables().get(jurisdiction);
  if (!table) throw new Error(`no binding table for ${jurisdiction}`);
  return {
    name: table.authority.name,
    ...(table.authority.url ? { url: table.authority.url } : {}),
  };
}

// What the first load set, counted for the fact sheet (D-10): every cookie, and those
// the database does not class as necessary.
export async function cookieCounts(
  connection: Connection,
  tenantId: string,
  caseId: string,
): Promise<{ total: number; nonNecessary: number }> {
  const observed = await withTenant(connection, tenantId, (db) => cookiesOf(db, caseId, cookies()));
  return {
    total: observed.length,
    nonNecessary: observed.filter((c) => c.classification.category !== 'necessary').length,
  };
}

export interface DocumentDraft {
  readonly kind: GeneratedKind;
  readonly locale: Locale;
  readonly document: GeneratedDocument;
}

// Write the document, or name the gaps. Nothing is stored here.
export async function draftDocument(
  connection: Connection,
  tenantId: string,
  caseId: string,
  kind: GeneratedKind,
  options: { now: Date; cookieDatabase?: CookieDatabase } = { now: new Date() },
): Promise<DocumentDraft> {
  return withTenant(connection, tenantId, async (db) => {
    const frame = await frameOf(db, caseId);
    if (kind === 'privacy_policy') {
      const rows = await registerProjection(db, caseId);
      const contact = await contactOf(db, caseId);
      const document = privacyPolicyDocument({
        rows,
        company: frame.company,
        contact,
        locale: frame.locale,
        authority: authorityOf(frame.jurisdiction),
        generatedAt: options.now,
      });
      return { kind, locale: frame.locale, document };
    }
    if (kind === 'processing_agreement' || kind === 'sub_processor_list') {
      const rows = await registerProjection(db, caseId);
      const graph = await graphOf(db, caseId);
      const processors = processorsOf(rows, graph);
      const subProcessors = subProcessorsOf(graph);
      const shared = {
        processors,
        subProcessors,
        company: frame.company,
        locale: frame.locale,
        generatedAt: options.now,
      };
      const document =
        kind === 'processing_agreement'
          ? processingAgreementDocument({ ...shared, contact: await contactOf(db, caseId) })
          : subProcessorListDocument(shared);
      return { kind, locale: frame.locale, document };
    }
    const observed = await cookiesOf(db, caseId, options.cookieDatabase ?? cookies());
    const document = cookieDeclarationDocument({
      cookies: observed,
      company: frame.company,
      locale: frame.locale,
      generatedAt: options.now,
    });
    return { kind, locale: frame.locale, document };
  });
}

export async function documentGaps(
  connection: Connection,
  tenantId: string,
  caseId: string,
  kind: GeneratedKind,
  options: { now?: Date; cookieDatabase?: CookieDatabase } = {},
): Promise<DocumentGap[]> {
  return withTenant(connection, tenantId, async (db) => {
    const frame = await frameOf(db, caseId);
    const now = options.now ?? new Date();
    if (kind === 'privacy_policy') {
      const rows = await registerProjection(db, caseId);
      const contact = await contactOf(db, caseId);
      return policyGaps({
        rows,
        company: frame.company,
        contact,
        locale: frame.locale,
        authority: authorityOf(frame.jurisdiction),
        generatedAt: now,
      });
    }
    if (kind === 'processing_agreement' || kind === 'sub_processor_list') {
      const rows = await registerProjection(db, caseId);
      const graph = await graphOf(db, caseId);
      const shared = {
        processors: processorsOf(rows, graph),
        subProcessors: subProcessorsOf(graph),
        company: frame.company,
        locale: frame.locale,
        generatedAt: now,
      };
      return kind === 'processing_agreement'
        ? agreementGaps({ ...shared, contact: await contactOf(db, caseId) })
        : subProcessorGaps(shared);
    }
    const observed = await cookiesOf(db, caseId, options.cookieDatabase ?? cookies());
    return cookieGaps({
      cookies: observed,
      company: frame.company,
      locale: frame.locale,
      generatedAt: now,
    });
  });
}

export type GenerateOutcome =
  | { readonly ok: true; readonly artefact: GeneratedArtefact }
  | { readonly ok: false; readonly gaps: readonly DocumentGap[] };

// Write and store a draft as a new version of the case's document of that kind, or
// refuse with the gaps. The draft is unsigned; the sign-off gate (A-09) stands.
export async function generateDocument(
  connection: Connection,
  tenantId: string,
  input: {
    caseId: string;
    kind: GeneratedKind;
    by: Actor;
    now?: Date;
    cookieDatabase?: CookieDatabase;
  },
): Promise<GenerateOutcome> {
  const now = input.now ?? new Date();
  const draft = await draftDocument(connection, tenantId, input.caseId, input.kind, {
    now,
    ...(input.cookieDatabase ? { cookieDatabase: input.cookieDatabase } : {}),
  });
  if (!draft.document.ok) return { ok: false, gaps: draft.document.gaps };
  const artefact = await generateArtefact(connection, tenantId, {
    caseId: input.caseId,
    kind: input.kind as ArtefactKind,
    locale: draft.locale,
    content: draft.document.markdown,
    by: input.by,
    now,
  });
  return { ok: true, artefact };
}
