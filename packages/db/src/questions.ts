import { eq } from 'drizzle-orm';
import { JurisdictionSchema, type Actor, type Jurisdiction } from '@gc/contracts';
import type { JobQueue } from '@gc/jobs';
import { cookieCounts, recordAnswer } from './documents.js';
import { requestCheck } from './members.js';
import { answers, cases, evidence, findings } from './schema.js';
import type { Connection } from './client.js';
import { withTenant } from './tenant.js';
import { appendEvent } from './timeline.js';

// Questions, one at a time (D-10): what the case holds of answers, what the site gave
// the fact sheet, and the two things a person can do with a question: answer it, or
// hand it to the agent. The answers table holds the current answer; every version lands
// on the timeline with who gave it, so a revised answer keeps the one it replaced.

export interface CaseAnswer {
  readonly questionId: string;
  readonly answer: string;
  readonly by: Actor;
  readonly at: Date;
}

export async function caseAnswers(
  connection: Connection,
  tenantId: string,
  caseId: string,
): Promise<CaseAnswer[]> {
  const rows = await withTenant(connection, tenantId, (db) =>
    db.select().from(answers).where(eq(answers.caseId, caseId)),
  );
  return rows
    .map((r) => ({
      questionId: r.questionId,
      answer: r.answer,
      by: r.answeredBy as Actor,
      at: r.answeredAt,
    }))
    .sort((a, b) => a.questionId.localeCompare(b.questionId));
}

export interface SiteFactSources {
  readonly findingTypeIds: readonly string[];
  // Absent until a scan has looked; then what it saw, even when it saw none.
  readonly cookies?: { readonly total: number; readonly nonNecessary: number };
}

export async function siteFactSources(
  connection: Connection,
  tenantId: string,
  caseId: string,
): Promise<SiteFactSources> {
  const [types, scanned] = await withTenant(connection, tenantId, async (db) => [
    await db.select({ typeId: findings.typeId }).from(findings).where(eq(findings.caseId, caseId)),
    await db.select({ id: evidence.id }).from(evidence).where(eq(evidence.caseId, caseId)).limit(1),
  ]);
  const findingTypeIds = [...new Set(types.map((t) => t.typeId))].sort();
  if (scanned.length === 0) return { findingTypeIds };
  const cookies = await cookieCounts(connection, tenantId, caseId);
  return { findingTypeIds, cookies };
}

export interface AnswerInput {
  readonly caseId: string;
  readonly questionId: string;
  // The option chosen, by id; what the fact sheet reads.
  readonly optionId: string;
  // The option as the person read it, for the timeline.
  readonly label: string;
  readonly question: string;
  readonly settled: number;
  readonly by: Actor;
  readonly at: Date;
}

// The current answer is replaced; the timeline keeps every one, with who gave it.
export async function answerQuestion(
  connection: Connection,
  tenantId: string,
  input: AnswerInput,
): Promise<void> {
  await recordAnswer(connection, tenantId, {
    caseId: input.caseId,
    questionId: input.questionId,
    answer: input.optionId,
    by: input.by,
    at: input.at,
  });
  await withTenant(connection, tenantId, (db) =>
    appendEvent(db, tenantId, input.caseId, input.at, input.by, 'question_answered', {
      questionId: input.questionId,
      answer: input.label,
      question: input.question,
      settled: input.settled,
    }),
  );
}

export const CHECK_OPTION = 'check';

export interface CheckRequest {
  readonly caseId: string;
  readonly questionId: string;
  readonly question: string;
  readonly jurisdiction: Jurisdiction;
  readonly by: Actor;
  readonly at: Date;
}

// "Check it for me": the question goes to the agent as a research task and the person
// moves on; the question is parked as answered `check` until the agent reports.
export async function requestQuestionCheck(
  connection: Connection,
  queue: JobQueue,
  tenantId: string,
  input: CheckRequest,
): Promise<string> {
  const jobId = await requestCheck(queue, {
    type: 'research',
    payload: { question: input.question, jurisdiction: input.jurisdiction, maxPassages: 5 },
    rationale: `the case holder asked for a check on ${input.questionId}`,
  });
  await recordAnswer(connection, tenantId, {
    caseId: input.caseId,
    questionId: input.questionId,
    answer: CHECK_OPTION,
    by: input.by,
    at: input.at,
  });
  await withTenant(connection, tenantId, (db) =>
    appendEvent(db, tenantId, input.caseId, input.at, input.by, 'check_requested', {
      questionId: input.questionId,
      jobId,
    }),
  );
  return jobId;
}

// The jurisdiction the case was opened in, as the rule sets name it.
export async function caseJurisdiction(
  connection: Connection,
  tenantId: string,
  caseId: string,
): Promise<Jurisdiction | undefined> {
  const [row] = await withTenant(connection, tenantId, (db) =>
    db
      .select({ jurisdiction: cases.jurisdiction })
      .from(cases)
      .where(eq(cases.id, caseId))
      .limit(1),
  );
  const parsed = JurisdictionSchema.safeParse(row?.jurisdiction);
  return parsed.success ? parsed.data : undefined;
}
