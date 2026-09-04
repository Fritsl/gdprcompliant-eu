import { z } from 'zod';
import {
  DutyStatusSchema,
  FindingTypeIdSchema,
  JurisdictionSchema,
  LocalisedTextSchema,
  NonEmptyStringSchema,
} from '@gc/contracts';

// The rule language (A-02). A rule is data a person can read: when these facts about
// the company hold, this duty applies, under these provisions. Facts are named paths
// into a flat fact sheet; conditions are comparisons joined by all, any and not. Every
// rule carries at least one citation and at least one worked example, so a rule cannot
// be added without saying where it comes from and showing what it does.

export const FACT_OPS = [
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'contains',
  'exists',
  'empty',
] as const;
export const FactOpSchema = z.enum(FACT_OPS);
export type FactOp = z.infer<typeof FactOpSchema>;

const ScalarSchema = z.union([z.string(), z.number(), z.boolean()]);
const ValueSchema = z.union([ScalarSchema, z.array(ScalarSchema)]);

export interface FactTest {
  readonly fact: string;
  readonly op: FactOp;
  readonly value?: z.infer<typeof ValueSchema>;
}
export type Condition =
  | FactTest
  | { readonly all: readonly Condition[] }
  | { readonly any: readonly Condition[] }
  | { readonly not: Condition };

const FactTestSchema: z.ZodType<FactTest> = z
  .strictObject({
    fact: z.string().regex(/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$/),
    op: FactOpSchema,
    value: ValueSchema.optional(),
  })
  .superRefine((t, ctx) => {
    const needsValue = !['exists', 'empty'].includes(t.op);
    if (needsValue && t.value === undefined)
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: `${t.op} compares against a value`,
      });
    if (t.op === 'in' && !Array.isArray(t.value))
      ctx.addIssue({ code: 'custom', path: ['value'], message: 'in takes a list' });
  }) as z.ZodType<FactTest>;

export const ConditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    FactTestSchema,
    z.strictObject({ all: z.array(ConditionSchema).min(1) }),
    z.strictObject({ any: z.array(ConditionSchema).min(1) }),
    z.strictObject({ not: ConditionSchema }),
  ]),
);

export const CitationRowSchema = z.object({
  instrument: NonEmptyStringSchema,
  ref: NonEmptyStringSchema,
  note: z.string().optional(),
});
export type CitationRow = z.infer<typeof CitationRowSchema>;

// A worked example: a fact sheet and the status the rule must give it.
export const RuleExampleSchema = z.object({
  name: NonEmptyStringSchema,
  facts: z.record(z.string(), z.unknown()),
  expect: DutyStatusSchema,
});
export type RuleExample = z.infer<typeof RuleExampleSchema>;

export const RuleSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  title: LocalisedTextSchema,
  // What the duty asks of the company, for a reader.
  summary: LocalisedTextSchema,
  // The rule fires when this holds; unknown facts make the duty undetermined.
  when: z.union([z.literal('always'), ConditionSchema]),
  // The rule does not fire when this holds, whatever `when` says.
  unless: ConditionSchema.optional(),
  citations: z.array(CitationRowSchema).min(1, 'a rule cites the provision it rests on'),
  // Finding types that, when raised, show the duty is not met.
  findingTypeIds: z.array(FindingTypeIdSchema).default([]),
  examples: z.array(RuleExampleSchema).min(1, 'a rule shows what it does on at least one example'),
});
export type Rule = z.infer<typeof RuleSchema>;

export const RuleSetSchema = z
  .object({
    version: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    // 'EU' rules apply in every supported jurisdiction; a country's set adds to them.
    jurisdiction: JurisdictionSchema,
    rules: z.array(RuleSchema).min(1),
  })
  .superRefine((s, ctx) => {
    const ids = new Set<string>();
    s.rules.forEach((r, i) => {
      if (ids.has(r.id))
        ctx.addIssue({
          code: 'custom',
          path: ['rules', i, 'id'],
          message: `duplicate rule id ${r.id}`,
        });
      ids.add(r.id);
    });
  });
export type RuleSet = z.infer<typeof RuleSetSchema>;

// Every fact path a condition reads.
export function factsRead(c: Condition | 'always'): string[] {
  if (c === 'always') return [];
  if ('all' in c) return c.all.flatMap(factsRead);
  if ('any' in c) return c.any.flatMap(factsRead);
  if ('not' in c) return factsRead(c.not);
  return [c.fact];
}
