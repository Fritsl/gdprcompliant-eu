import { randomBytes } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import {
  AdviceSchema,
  CompanySchema,
  type Actor,
  type Advice,
  type Company,
  type DiveOrigin,
  type Jurisdiction,
  type Locale,
  type RegisterRow,
} from '@gc/contracts';
import { factsSetBy, loadQuestions } from '@gc/rules';
import type { Connection } from './client.js';
import { processorsOf } from './documents.js';
import { findingsWithEvidence } from './findings.js';
import { graphOf, registerProjection } from './graph.js';
import { answers, caseEvents, cases } from './schema.js';
import { appendCaseEvent } from './timeline.js';
import { withTenant } from './tenant.js';

// What the case-grounded advisor (V-02) speaks from: every finding with the evidence
// that raised it, every register row with the evidence that placed it, every answer a
// person gave, every supplier the graph names. Each carries the pointer the answer will
// cite, so a reader can follow "the case says" to the row that says it. The answer
// itself goes on the timeline, and the report reads it back from there.

interface Pointer {
  readonly evidenceId: string;
  readonly hash: string;
}

export interface AdviceFindingFact {
  readonly id: string;
  readonly typeId: string;
  readonly status: string;
  readonly summary?: string;
  readonly evidence: readonly Pointer[];
}

export interface AdviceAnswerFact {
  readonly id: string;
  readonly questionId: string;
  readonly answer: string;
  readonly asks?: string;
}

export interface AdviceVendorFact {
  readonly nodeId: string;
  readonly name: string;
  readonly country?: string;
  readonly role?: string;
  readonly evidence: readonly Pointer[];
}

export interface CaseFactsRecord {
  readonly company: Company;
  readonly locale: Locale;
  readonly jurisdiction: Jurisdiction;
  readonly findings: readonly AdviceFindingFact[];
  readonly rows: readonly RegisterRow[];
  readonly answers: readonly AdviceAnswerFact[];
  readonly vendors: readonly AdviceVendorFact[];
}

const asksIn = (asks: Record<string, string | undefined>, locale: Locale): string =>
  asks[locale] ?? asks['en'] ?? '';

export async function caseFactsInput(
  connection: Connection,
  tenantId: string,
  caseId: string,
): Promise<CaseFactsRecord> {
  const found = await findingsWithEvidence(connection, tenantId, caseId);
  return withTenant(connection, tenantId, async (db) => {
    const [row] = await db
      .select({ locale: cases.locale, jurisdiction: cases.jurisdiction, company: cases.company })
      .from(cases)
      .where(eq(cases.id, caseId))
      .limit(1);
    if (!row) throw new Error(`no case ${caseId}`);
    const locale = row.locale as Locale;
    const rows = await registerProjection(db, caseId);
    const graph = await graphOf(db, caseId);
    const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
    const given = await db.select().from(answers).where(eq(answers.caseId, caseId));
    const catalogue = new Map(loadQuestions().questions.map((q) => [q.id, q]));
    return {
      company: CompanySchema.parse(row.company),
      locale,
      jurisdiction: row.jurisdiction as Jurisdiction,
      findings: found.map(({ finding, evidence }) => {
        const quote = evidence.find((e) => e.quote)?.quote;
        return {
          id: finding.id,
          typeId: finding.typeId,
          status: finding.status,
          ...(quote ? { summary: quote } : {}),
          evidence: evidence.map((e) => ({ evidenceId: e.id, hash: e.hash })),
        };
      }),
      rows,
      answers: given
        .sort((a, b) => a.questionId.localeCompare(b.questionId))
        .map((a) => {
          const q = catalogue.get(a.questionId);
          return {
            id: a.id,
            questionId: a.questionId,
            answer: a.answer,
            ...(q ? { asks: asksIn(q.asks, locale) } : {}),
          };
        }),
      vendors: processorsOf(rows, graph, true).flatMap((p) => {
        const node = nodes.get(p.nodeId);
        const evidence = (node?.evidence ?? []).map((e) => ({
          evidenceId: e.evidenceId,
          hash: e.hash,
        }));
        if (evidence.length === 0) return [];
        return [
          {
            nodeId: p.nodeId,
            name: p.name,
            ...(p.country ? { country: p.country } : {}),
            role: 'processor',
            evidence,
          },
        ];
      }),
    };
  });
}

// The catalogue the advisor names a settling question from: every question, in the
// case's language, with the facts its answer sets.
export interface AdvisorCatalogueEntry {
  readonly id: string;
  readonly asks: string;
  readonly facts: readonly string[];
}

export const advisorCatalogue = (locale: Locale): AdvisorCatalogueEntry[] =>
  loadQuestions().questions.map((q) => ({
    id: q.id,
    asks: asksIn(q.asks, locale),
    facts: factsSetBy(q),
  }));

export interface RecordAdviceInput {
  readonly caseId: string;
  readonly advice: Advice;
  readonly by: Actor;
  readonly now?: Date;
}

export async function recordAdvice(
  connection: Connection,
  tenantId: string,
  input: RecordAdviceInput,
): Promise<void> {
  const advice = AdviceSchema.parse(input.advice);
  await withTenant(connection, tenantId, (db) =>
    appendCaseEvent(db, {
      tenantId,
      caseId: input.caseId,
      at: input.now ?? new Date(advice.at),
      actor: input.by,
      type: 'advice_recorded',
      payload: { question: advice.question, refused: advice.refused !== undefined, advice },
    }),
  );
}

export async function adviceOf(
  connection: Connection,
  tenantId: string,
  caseId: string,
): Promise<Advice[]> {
  const rows = await withTenant(connection, tenantId, (db) =>
    db
      .select()
      .from(caseEvents)
      .where(and(eq(caseEvents.caseId, caseId), eq(caseEvents.type, 'advice_recorded')))
      .orderBy(asc(caseEvents.seq)),
  );
  return rows.map((r) => AdviceSchema.parse((r.payload as { advice: unknown }).advice));
}

// A conversation id (V-05): one per dive or first question, carried by every turn.
export const newThreadId = (caseId: string): string =>
  `thread:${caseId}:${randomBytes(6).toString('hex')}`;

export interface RecordDiveInput {
  readonly caseId: string;
  readonly threadId: string;
  readonly turn: number;
  readonly origin: DiveOrigin;
  readonly fragment: string;
  readonly by: Actor;
  readonly now?: Date;
}

// Every dive is on the timeline, so the case shows what was asked about.
export async function recordDive(
  connection: Connection,
  tenantId: string,
  input: RecordDiveInput,
): Promise<void> {
  await withTenant(connection, tenantId, (db) =>
    appendCaseEvent(db, {
      tenantId,
      caseId: input.caseId,
      at: input.now ?? new Date(),
      actor: input.by,
      type: 'dive_requested',
      payload: {
        threadId: input.threadId,
        turn: input.turn,
        origin: input.origin,
        fragment: input.fragment,
      },
    }),
  );
}

// The turns of one conversation, oldest first.
export async function threadOf(
  connection: Connection,
  tenantId: string,
  caseId: string,
  threadId: string,
): Promise<Advice[]> {
  const all = await adviceOf(connection, tenantId, caseId);
  return all.filter((a) => a.thread?.id === threadId);
}
