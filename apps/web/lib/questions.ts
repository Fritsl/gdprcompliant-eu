import 'server-only';
import type { Jurisdiction, Locale } from '@gc/contracts';
import {
  CHECK_OPTION,
  answerQuestion,
  caseAnswers,
  caseByToken,
  caseCompany,
  caseJurisdiction,
  registerRows,
  requestQuestionCheck,
  siteFactSources,
  type CaseAnswer,
  type Connection,
} from '@gc/db';
import { localise } from '@gc/i18n';
import { JobQueue } from '@gc/jobs';
import {
  answerFacts,
  evaluate,
  explainSelection,
  factsFrom,
  loadQuestions,
  loadRuleSets,
  loadSectors,
  selectQuestions,
  type Facts,
  type Question,
} from '@gc/rules';
import { holder, withConnection } from '@/lib/case';

// Questions, one at a time (D-10). Which question comes next is the rules engine's
// choice (D-09): the one whose answer settles the most duties the engine cannot decide
// from what the case holds. Every answer is one form post, lands on the timeline as the
// holder, and the next screen says what it settled. "Check it for me" hands the question
// to the agent and moves on.

const sets = loadRuleSets();
const catalogue = loadQuestions();
const sectors = loadSectors();

const pick = (text: Record<string, string>, locale: Locale): string => localise(text, locale).value;

interface CaseState {
  readonly found: { caseId: string; tenantId: string };
  readonly jurisdiction: Jurisdiction;
  readonly answers: readonly CaseAnswer[];
  // The sheet with every answer in, and the sheet without the answers at all.
  readonly facts: Facts;
  readonly observed: Facts;
  readonly sector: string;
  readonly factsWithout: (questionId: string) => Facts;
}

const answered = (rows: readonly CaseAnswer[]) =>
  rows.map((a) => ({ questionId: a.questionId, optionId: a.answer }));

async function stateOf(
  connection: Connection,
  found: { caseId: string; tenantId: string },
): Promise<CaseState | undefined> {
  const company = await caseCompany(connection, found.tenantId, found.caseId);
  if (!company) return undefined;
  const jurisdiction = (await caseJurisdiction(connection, found.tenantId, found.caseId)) ?? 'DK';
  const rows = await registerRows(connection, found.tenantId, found.caseId);
  const site = await siteFactSources(connection, found.tenantId, found.caseId);
  const answers = await caseAnswers(connection, found.tenantId, found.caseId);
  const sheet = (given: readonly CaseAnswer[]) =>
    factsFrom({
      company,
      rows,
      findingTypeIds: site.findingTypeIds,
      ...(site.cookies ? { cookies: site.cookies } : {}),
      answers: answerFacts(catalogue, answered(given)),
      sectors,
    });
  const full = sheet(answers);
  return {
    found,
    jurisdiction,
    answers,
    facts: full.facts,
    observed: sheet([]).facts,
    sector: full.sector.sector,
    factsWithout: (questionId) => sheet(answers.filter((a) => a.questionId !== questionId)).facts,
  };
}

const undetermined = (state: CaseState, facts: Facts): string[] =>
  evaluate(sets, { caseId: state.found.caseId, jurisdiction: state.jurisdiction, facts })
    .filter((d) => d.status === 'undetermined')
    .map((d) => d.ruleId);

const ruleTitle = (ruleId: string, locale: Locale): string => {
  for (const set of sets) {
    const rule = set.rules.find((r) => r.id === ruleId);
    if (rule) return pick(rule.title, locale);
  }
  return ruleId;
};

export interface QuestionOptionView {
  readonly id: string;
  readonly label: string;
  readonly check: boolean;
}

export interface QuestionView {
  readonly id: string;
  readonly asks: string;
  readonly why: string;
  readonly explanation: string;
  // The duties an answer would settle, by title.
  readonly settles: readonly string[];
  readonly options: readonly QuestionOptionView[];
  // The option chosen before, when the question is being revisited.
  readonly current?: string;
}

export interface AnsweredView {
  readonly id: string;
  readonly asks: string;
  readonly label: string;
}

export interface QuestionScreen {
  readonly caseId: string;
  readonly question?: QuestionView;
  // Where the person is: answered so far, and how many the case wants in all.
  readonly index: number;
  readonly total: number;
  readonly answered: readonly AnsweredView[];
  readonly dutiesSettled: number;
  readonly settledNow: readonly string[];
  readonly checkJobId?: string;
}

const optionView = (q: Question, locale: Locale): QuestionOptionView[] =>
  q.options.map((o) => ({ id: o.id, label: pick(o.label, locale), check: o.id === CHECK_OPTION }));

export function loadQuestionScreen(
  token: string,
  locale: Locale,
  opts: { revisit?: string; settled?: string; checking?: string } = {},
): Promise<QuestionScreen | undefined> {
  return withConnection(async (connection) => {
    const found = await caseByToken(connection, token);
    if (!found) return undefined;
    const state = await stateOf(connection, found);
    if (!state) return undefined;
    const selection = selectQuestions(sets, catalogue, {
      jurisdiction: state.jurisdiction,
      facts: state.facts,
      sector: state.sector,
      answered: state.answers.map((a) => a.questionId),
      limit: 10,
    });
    const answeredViews: AnsweredView[] = state.answers.flatMap((a) => {
      const q = catalogue.questions.find((x) => x.id === a.questionId);
      const o = q?.options.find((x) => x.id === a.answer);
      return q
        ? [{ id: q.id, asks: pick(q.asks, locale), label: o ? pick(o.label, locale) : a.answer }]
        : [];
    });
    let question: QuestionView | undefined;
    const revisit = opts.revisit
      ? catalogue.questions.find((q) => q.id === opts.revisit)
      : undefined;
    if (revisit) {
      const without = state.factsWithout(revisit.id);
      const again = selectQuestions(sets, catalogue, {
        jurisdiction: state.jurisdiction,
        facts: without,
        sector: state.sector,
        answered: state.answers.filter((a) => a.questionId !== revisit.id).map((a) => a.questionId),
        limit: 100,
      }).asked.find((s) => s.question.id === revisit.id);
      const current = state.answers.find((a) => a.questionId === revisit.id)?.answer;
      question = {
        id: revisit.id,
        asks: pick(revisit.asks, locale),
        why: pick(revisit.why, locale),
        explanation: again ? explainSelection(again, catalogue, locale, sectors, state.sector) : '',
        settles: again ? again.resolves.map((r) => pick(r.title, locale)) : [],
        options: optionView(revisit, locale),
        ...(current ? { current } : {}),
      };
    } else {
      const next = selection.asked[0];
      if (next)
        question = {
          id: next.question.id,
          asks: pick(next.question.asks, locale),
          why: pick(next.question.why, locale),
          explanation: explainSelection(next, catalogue, locale, sectors, state.sector),
          settles: next.resolves.map((r) => pick(r.title, locale)),
          options: optionView(next.question, locale),
        };
    }
    const dutiesSettled =
      undetermined(state, state.observed).length - undetermined(state, state.facts).length;
    const settledNow = (opts.settled ?? '')
      .split(',')
      .filter((id) => id.length > 0)
      .map((id) => ruleTitle(id, locale));
    return {
      caseId: found.caseId,
      ...(question ? { question } : {}),
      index: state.answers.length + (question ? 1 : 0),
      total: state.answers.length + selection.asked.length,
      answered: answeredViews,
      dutiesSettled,
      settledNow,
      ...(opts.checking ? { checkJobId: opts.checking } : {}),
    };
  });
}

export type AnswerOutcome =
  | { readonly ok: true; readonly settled: readonly string[]; readonly checkJobId?: string }
  | { readonly ok: false };

// One answer: recorded as the holder, on the timeline, and the duties it settled named
// by rule id for the next screen. A check goes to the queue and returns at once.
export async function answerForOwner(
  token: string,
  questionId: string,
  optionId: string,
): Promise<AnswerOutcome> {
  const outcome = await withConnection(async (connection): Promise<AnswerOutcome> => {
    const found = await caseByToken(connection, token);
    if (!found) return { ok: false };
    const q = catalogue.questions.find((x) => x.id === questionId);
    const option = q?.options.find((o) => o.id === optionId);
    if (!q || !option) return { ok: false };
    const state = await stateOf(connection, found);
    if (!state) return { ok: false };
    const by = holder(found.caseId);
    const at = new Date();
    const question = pick(q.asks, 'en');
    if (option.id === CHECK_OPTION) {
      const url = process.env['DATABASE_URL'];
      if (!url) return { ok: false };
      const queue = new JobQueue({ connectionString: url });
      await queue.start();
      try {
        const checkJobId = await requestQuestionCheck(connection, queue, found.tenantId, {
          caseId: found.caseId,
          questionId,
          question,
          jurisdiction: state.jurisdiction,
          by,
          at,
        });
        return { ok: true, settled: [], checkJobId };
      } finally {
        await queue.stop({ graceful: true });
      }
    }
    const before = undetermined(state, state.factsWithout(questionId));
    const after = undetermined(state, { ...state.factsWithout(questionId), ...option.sets });
    const settled = before.filter((id) => !after.includes(id));
    await answerQuestion(connection, found.tenantId, {
      caseId: found.caseId,
      questionId,
      optionId,
      label: pick(option.label, 'en'),
      question,
      settled: settled.length,
      by,
      at,
    });
    return { ok: true, settled };
  });
  return outcome ?? { ok: false };
}

export async function questionCounts(
  token: string,
): Promise<{ open: number; answered: number } | undefined> {
  const screen = await loadQuestionScreen(token, 'en');
  if (!screen) return undefined;
  return { open: screen.total - screen.answered.length, answered: screen.answered.length };
}
