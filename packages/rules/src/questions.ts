import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  LocalisedTextSchema,
  type Jurisdiction,
  type Locale,
  type LocalisedText,
} from '@gc/contracts';
import { evaluateCondition, setsFor, statusOf } from './engine.js';
import { FACT_NAMES, type Facts, type FactValue } from './facts.js';
import { ConditionSchema, factsRead, type Rule, type RuleSet } from './language.js';
import type { Sector } from './sector.js';

// Question selection (D-09). The catalogue is content: each question names the facts
// each of its answers would set and the rules it declares an answer would settle.
// Selection is the engine run backwards: evaluate the duties, take the undetermined
// ones, and ask only what would turn one of them into applies or not applicable. A fact
// the sheet already holds is never asked for, an answered question is never asked
// twice, and every selection carries, in words, which duties turned on it and why it
// came early.

const FactValueSchema = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);

export const QuestionOptionSchema = z.object({
  id: z.string().regex(/^[a-z0-9+]+(-[a-z0-9+]+)*$/),
  label: LocalisedTextSchema,
  // The facts this answer establishes; empty for "not sure".
  sets: z.record(z.string(), FactValueSchema).default({}),
});
export type QuestionOption = z.infer<typeof QuestionOptionSchema>;

export const QuestionSchema = z.object({
  id: z.string().regex(/^q-[a-z0-9]+(-[a-z0-9]+)*$/),
  asks: LocalisedTextSchema,
  why: LocalisedTextSchema,
  // Asked only when this holds or is unknown; never when it is false.
  askWhen: ConditionSchema.optional(),
  // Sectors the question belongs to: asked early there, not at all elsewhere once the
  // sector is known. Absent means every sector.
  sectors: z.array(z.string()).optional(),
  options: z.array(QuestionOptionSchema).min(2),
  // The rules an answer would settle, declared so a reviewer can see it; the check
  // refuses a declaration the rule sets do not bear out.
  resolves: z.array(z.string()).min(1),
});
export type Question = z.infer<typeof QuestionSchema>;

export const QuestionCatalogueSchema = z
  .object({
    version: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    copy: z.object({
      because: LocalisedTextSchema,
      becauseOne: LocalisedTextSchema,
      sector: LocalisedTextSchema,
    }),
    questions: z.array(QuestionSchema).min(1),
  })
  .superRefine((c, ctx) => {
    const ids = new Set<string>();
    c.questions.forEach((q, i) => {
      if (ids.has(q.id))
        ctx.addIssue({
          code: 'custom',
          path: ['questions', i, 'id'],
          message: `duplicate ${q.id}`,
        });
      ids.add(q.id);
      const options = new Set<string>();
      q.options.forEach((o, j) => {
        if (options.has(o.id))
          ctx.addIssue({
            code: 'custom',
            path: ['questions', i, 'options', j, 'id'],
            message: `duplicate option ${o.id}`,
          });
        options.add(o.id);
      });
    });
  });
export type QuestionCatalogue = z.infer<typeof QuestionCatalogueSchema>;

export const QUESTIONS_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../content/questions.json',
);

export function loadQuestions(file: string = QUESTIONS_FILE): QuestionCatalogue {
  return QuestionCatalogueSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}

// Every fact any answer to the question would set.
export const factsSetBy = (q: Question): string[] =>
  [...new Set(q.options.flatMap((o) => Object.keys(o.sets)))].sort();

const withFacts = (facts: Facts, more: Readonly<Record<string, FactValue>>): Facts => ({
  ...facts,
  ...more,
});

// The rules, among those speaking in the jurisdiction, that an answer would settle on
// this sheet: undetermined now, determined under at least one option.
export function rulesSettledBy(
  q: Question,
  sets: readonly RuleSet[],
  jurisdiction: Jurisdiction,
  facts: Facts,
): { set: RuleSet; rule: Rule }[] {
  const out: { set: RuleSet; rule: Rule }[] = [];
  for (const set of setsFor(sets, jurisdiction))
    for (const rule of set.rules) {
      if (statusOf(rule, facts) !== 'undetermined') continue;
      if (q.options.some((o) => statusOf(rule, withFacts(facts, o.sets)) !== 'undetermined'))
        out.push({ set, rule });
    }
  return out;
}

// What a question can settle at all: the rules that read a fact one of its answers sets.
export function rulesReading(q: Question, sets: readonly RuleSet[]): string[] {
  const facts = new Set(factsSetBy(q));
  const ids = new Set<string>();
  for (const set of sets)
    for (const rule of set.rules) {
      const read = [...factsRead(rule.when), ...(rule.unless ? factsRead(rule.unless) : [])];
      if (read.some((f) => facts.has(f))) ids.add(rule.id);
    }
  return [...ids].sort();
}

const NARRATION = [/\bbelow\b/i, /\babove\b/i, /on this page/i, /you just need/i];

// The catalogue against the rule sets: what CI refuses.
export function checkQuestions(
  catalogue: QuestionCatalogue,
  sets: readonly RuleSet[],
  sectors: readonly Sector[],
): string[] {
  const problems: string[] = [];
  const known = new Set(Object.keys(FACT_NAMES));
  const ruleIds = new Set(sets.flatMap((s) => s.rules.map((r) => r.id)));
  const sectorIds = new Set(sectors.map((s) => s.id));
  for (const q of catalogue.questions) {
    for (const f of factsSetBy(q))
      if (!known.has(f))
        problems.push(`${q.id} sets the fact ${f}, which the fact sheet never holds`);
    if (q.askWhen)
      for (const f of factsRead(q.askWhen))
        if (!known.has(f))
          problems.push(`${q.id} asks when ${f}, which the fact sheet never holds`);
    for (const s of q.sectors ?? [])
      if (!sectorIds.has(s))
        problems.push(`${q.id} names the sector ${s}, which is not on the list`);
    for (const r of q.resolves)
      if (!ruleIds.has(r))
        problems.push(`${q.id} declares it resolves ${r}, which no rule set holds`);
    const actual = rulesReading(q, sets);
    const declared = [...q.resolves].sort();
    if (actual.join(',') !== declared.join(','))
      problems.push(
        `${q.id} declares it resolves [${declared.join(', ')}] but the rules reading its facts are [${actual.join(', ')}]`,
      );
    if (actual.length === 0)
      problems.push(`${q.id} settles no rule; a question nothing turns on is not asked`);
    if (!q.options.some((o) => Object.keys(o.sets).length > 0))
      problems.push(`${q.id} has no answer that establishes a fact`);
    for (const [locale, text] of Object.entries(q.asks))
      if (!text.trim().endsWith('?'))
        problems.push(`${q.id} (${locale}) is not written as a question`);
    for (const text of [...Object.values(q.asks), ...Object.values(q.why)])
      for (const p of NARRATION)
        if (p.test(text)) problems.push(`${q.id} narrates the page: "${text}"`);
  }
  return problems;
}

export interface SelectionInput {
  readonly jurisdiction: Jurisdiction;
  readonly facts: Facts;
  // The sector inferred for the company, or unknown.
  readonly sector?: string | undefined;
  // Questions already answered, or declined, on this case.
  readonly answered?: readonly string[] | undefined;
  readonly limit?: number | undefined;
}

export interface SelectedQuestion {
  readonly question: Question;
  // The facts the sheet lacks that an answer would establish.
  readonly fills: readonly string[];
  // The duties that turn on the answer.
  readonly resolves: readonly {
    ruleId: string;
    jurisdiction: Jurisdiction;
    title: LocalisedText;
  }[];
  readonly sectorMatched: boolean;
  readonly rank: number;
}

export interface Selection {
  readonly asked: readonly SelectedQuestion[];
  // Every candidate not asked, and why, for the case log.
  readonly skipped: readonly { questionId: string; reason: string }[];
}

export function selectQuestions(
  sets: readonly RuleSet[],
  catalogue: QuestionCatalogue,
  input: SelectionInput,
): Selection {
  const answered = new Set(input.answered ?? []);
  const sector = input.sector && input.sector !== 'unknown' ? input.sector : undefined;
  const skipped: { questionId: string; reason: string }[] = [];
  const candidates: Omit<SelectedQuestion, 'rank'>[] = [];
  for (const q of catalogue.questions) {
    if (answered.has(q.id)) {
      skipped.push({ questionId: q.id, reason: 'already answered' });
      continue;
    }
    if (sector && q.sectors && !q.sectors.includes(sector)) {
      skipped.push({ questionId: q.id, reason: `not asked in ${sector}` });
      continue;
    }
    if (q.askWhen && evaluateCondition(q.askWhen, input.facts) === 'false') {
      skipped.push({ questionId: q.id, reason: 'its condition does not hold' });
      continue;
    }
    const fills = factsSetBy(q).filter((f) => input.facts[f] === undefined);
    if (fills.length === 0) {
      skipped.push({ questionId: q.id, reason: 'already known from evidence held' });
      continue;
    }
    const settled = rulesSettledBy(q, sets, input.jurisdiction, input.facts);
    if (settled.length === 0) {
      skipped.push({ questionId: q.id, reason: 'no duty turns on the answer' });
      continue;
    }
    candidates.push({
      question: q,
      fills,
      resolves: settled.map(({ set, rule }) => ({
        ruleId: rule.id,
        jurisdiction: set.jurisdiction,
        title: rule.title,
      })),
      sectorMatched: sector !== undefined && (q.sectors?.includes(sector) ?? false),
    });
  }
  candidates.sort(
    (a, b) =>
      Number(b.sectorMatched) - Number(a.sectorMatched) ||
      b.resolves.length - a.resolves.length ||
      a.question.id.localeCompare(b.question.id),
  );
  const limit = input.limit ?? 5;
  const asked = candidates.map((c, i) => ({ ...c, rank: i + 1 }));
  for (const c of asked.slice(limit))
    skipped.push({ questionId: c.question.id, reason: `beyond the first ${limit}` });
  return { asked: asked.slice(0, limit), skipped };
}

const pick = (text: LocalisedText, locale: Locale): string => text[locale] ?? text['en'] ?? '';

// Why the case asked what it asked, for the person reading it.
export function explainSelection(
  selected: SelectedQuestion,
  catalogue: QuestionCatalogue,
  locale: Locale,
  sectors: readonly Sector[] = [],
  sector?: string,
): string {
  const n = selected.resolves.length;
  const duties = selected.resolves.map((r) => pick(r.title, locale)).join('; ');
  const lines = [
    pick(n === 1 ? catalogue.copy.becauseOne : catalogue.copy.because, locale)
      .replace('{n}', String(n))
      .replace('{duties}', duties),
  ];
  const named = sectors.find((s) => s.id === sector);
  if (selected.sectorMatched && named)
    lines.push(pick(catalogue.copy.sector, locale).replace('{sector}', pick(named.title, locale)));
  return lines.join(' ');
}

// Answers as facts: the option's `sets`, in the order answered. An answer to a question
// the catalogue does not hold, or with an option it does not have, sets nothing.
export function answerFacts(
  catalogue: QuestionCatalogue,
  answers: readonly { questionId: string; optionId: string }[],
): Facts {
  const out: Record<string, FactValue> = {};
  for (const a of answers) {
    const option = catalogue.questions
      .find((q) => q.id === a.questionId)
      ?.options.find((o) => o.id === a.optionId);
    if (option) Object.assign(out, option.sets);
  }
  return out;
}
