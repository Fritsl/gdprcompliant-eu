import { z } from 'zod';
import {
  FINDING_STATUSES,
  FindingAreaSchema,
  SEVERITIES,
  SeveritySchema,
  type FindingArea,
  type FindingStatus,
  type Severity,
} from '@gc/contracts';
import severityJson from '../content/severity.json' with { type: 'json' };

// Severity (S-14) comes from one documented table, never from a detector's mood: the
// type's base severity (detectors.json), then the rules in severity.json, applied in
// order. Every rule names its condition and its effect, so a lawyer or an operator can
// read why a finding is as serious as it is. docs/decisions/severity.md.

const RuleSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  description: z.string().min(1),
  when: z.object({
    observed: z.boolean().optional(),
    areas: z.array(FindingAreaSchema).optional(),
    minHosts: z.number().int().min(1).optional(),
    sectorPrefixes: z.array(z.string().regex(/^\d{2,4}$/)).optional(),
    previousStatus: z.array(z.enum(FINDING_STATUSES)).optional(),
  }),
  effect: z.enum(['max-observed', 'raise', 'lower', 'set']),
  by: z.number().int().min(1).optional(),
  to: SeveritySchema.optional(),
});
export type SeverityRule = z.infer<typeof RuleSchema>;

export const SeverityTableSchema = z.object({
  version: z.number().int().min(1),
  levels: z.tuple([z.literal('advisory'), z.literal('serious'), z.literal('blocking')]),
  rules: z.array(RuleSchema),
});
export type SeverityTable = z.infer<typeof SeverityTableSchema>;

export const SEVERITY_TABLE: SeverityTable = SeverityTableSchema.parse(severityJson);

export interface SeverityContext {
  readonly area: FindingArea;
  // What the detector graded, where it grades (forms, replay).
  readonly observed?: Severity;
  readonly hosts?: number;
  readonly sectorCode?: string;
  readonly previousStatus?: FindingStatus;
}

export interface SeverityDecision {
  readonly severity: Severity;
  readonly base: Severity;
  // The rules that applied, in order.
  readonly applied: readonly string[];
}

const rank = (s: Severity): number => SEVERITIES.indexOf(s);
const at = (i: number): Severity =>
  SEVERITIES[Math.min(SEVERITIES.length - 1, Math.max(0, i))] as Severity;
// SEVERITIES runs blocking, serious, advisory: raising a level lowers the index.
const raise = (s: Severity, by: number): Severity => at(rank(s) - by);
const lower = (s: Severity, by: number): Severity => at(rank(s) + by);
const higher = (a: Severity, b: Severity): Severity => (rank(a) <= rank(b) ? a : b);

function applies(rule: SeverityRule, ctx: SeverityContext): boolean {
  const w = rule.when;
  if (w.observed !== undefined && (ctx.observed !== undefined) !== w.observed) return false;
  if (w.areas && !w.areas.includes(ctx.area)) return false;
  if (w.minHosts !== undefined && (ctx.hosts ?? 0) < w.minHosts) return false;
  if (w.sectorPrefixes) {
    const code = (ctx.sectorCode ?? '').replace(/\./g, '');
    if (!w.sectorPrefixes.some((p) => code.startsWith(p))) return false;
  }
  if (w.previousStatus && (!ctx.previousStatus || !w.previousStatus.includes(ctx.previousStatus)))
    return false;
  return true;
}

export function severityFor(
  base: Severity,
  ctx: SeverityContext,
  table: SeverityTable = SEVERITY_TABLE,
): SeverityDecision {
  let severity = base;
  const applied: string[] = [];
  for (const rule of table.rules) {
    if (!applies(rule, ctx)) continue;
    let next = severity;
    switch (rule.effect) {
      case 'max-observed':
        next = ctx.observed ? higher(severity, ctx.observed) : severity;
        break;
      case 'raise':
        next = raise(severity, rule.by ?? 1);
        break;
      case 'lower':
        next = lower(severity, rule.by ?? 1);
        break;
      case 'set':
        next = rule.to ?? severity;
        break;
    }
    if (next !== severity) applied.push(rule.id);
    severity = next;
  }
  return { severity, base, applied };
}
