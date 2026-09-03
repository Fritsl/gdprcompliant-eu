import { eq } from 'drizzle-orm';
import { CASE_STAGES, type ArtefactKind, type CaseEvent, type CaseStage } from '@gc/contracts';
import type { Connection } from './client.js';
import { cases } from './schema.js';
import { withTenant } from './tenant.js';
import { caseTimeline } from './timeline.js';

// The case state machine (C-03): opened → assessed → working → documented → watched.
// The transitions are declared once, here. A stage is never set by hand: it is derived
// from what has actually happened (the timeline) and what actually exists (the
// artefacts), one step at a time, and never moves backwards without saying so.
// Watched is where a case rests; nothing is terminal, because the weekly check keeps
// running and a finding can come back.

export const CASE_TRANSITIONS: Readonly<Record<CaseStage, readonly CaseStage[]>> = {
  opened: ['assessed'],
  assessed: ['working'],
  working: ['documented'],
  documented: ['watched'],
  watched: [],
};

export const RESTING_STAGE: CaseStage = 'watched';

// Documented means these exist and have been published, not that someone said so.
export const DOCUMENTED_REQUIRES: readonly ArtefactKind[] = [
  'processing_register',
  'privacy_policy',
  'processing_agreement',
];

export interface ArtefactFact {
  readonly kind: ArtefactKind;
  readonly published: boolean;
}

export interface CaseFacts {
  readonly events: readonly CaseEvent[];
  readonly artefacts: readonly ArtefactFact[];
}

export const stageRank = (stage: CaseStage): number => CASE_STAGES.indexOf(stage);
export const canTransition = (from: CaseStage, to: CaseStage): boolean =>
  CASE_TRANSITIONS[from].includes(to);
export const nextStage = (from: CaseStage): CaseStage | undefined => CASE_TRANSITIONS[from][0];

const has = (facts: CaseFacts, type: CaseEvent['type']): boolean =>
  facts.events.some((e) => e.type === type);

// What each stage needs, and in words why it is not there yet.
const REQUIREMENTS: Readonly<Record<Exclude<CaseStage, 'opened'>, (f: CaseFacts) => string[]>> = {
  assessed: (f) => (has(f, 'scan_completed') ? [] : ['no scan has completed']),
  working: (f) =>
    has(f, 'finding_closed') || has(f, 'question_answered')
      ? []
      : ['no finding has been closed and no question answered'],
  documented: (f) =>
    DOCUMENTED_REQUIRES.filter(
      (kind) =>
        !f.artefacts.some((a) => a.kind === kind && a.published) ||
        !f.events.some(
          (e) => e.type === 'artefact_published' && (e.payload as { kind: string }).kind === kind,
        ),
    ).map((kind) => `${kind} is not published`),
  watched: (f) => (has(f, 'watch_run') ? [] : ['no weekly check has run']),
};

export function requirementsFor(stage: CaseStage, facts: CaseFacts): string[] {
  return stage === 'opened' ? [] : REQUIREMENTS[stage](facts);
}

export interface Derivation {
  // The furthest stage the facts support, walking the chain from opened.
  readonly stage: CaseStage;
  // The stage after it, and what is missing for it. Absent at the resting stage.
  readonly next?: CaseStage;
  readonly missing: readonly string[];
}

export function deriveStage(facts: CaseFacts): Derivation {
  let stage: CaseStage = 'opened';
  for (;;) {
    const next = nextStage(stage);
    if (!next) return { stage, missing: [] };
    const missing = requirementsFor(next, facts);
    if (missing.length > 0) return { stage, next, missing };
    stage = next;
  }
}

export interface StageStep {
  readonly from: CaseStage;
  readonly to: CaseStage;
  // Set when the case moved: exactly one declared transition.
  readonly transition?: { readonly from: CaseStage; readonly to: CaseStage };
  // Set when the facts no longer support the current stage. The stage stays; the
  // caller decides what to do with the fact that it should not.
  readonly regression?: {
    readonly from: CaseStage;
    readonly derived: CaseStage;
    readonly because: readonly string[];
  };
  // What the next stage still needs, if there is one.
  readonly missing: readonly string[];
}

// One step: forward by one declared transition when the facts support it, never
// backwards, never a skip.
export function stepStage(current: CaseStage, facts: CaseFacts): StageStep {
  const derived = deriveStage(facts);
  if (stageRank(derived.stage) < stageRank(current)) {
    const lost = nextStage(derived.stage);
    return {
      from: current,
      to: current,
      regression: {
        from: current,
        derived: derived.stage,
        because: lost ? requirementsFor(lost, facts) : [],
      },
      missing: derived.missing,
    };
  }
  const next = nextStage(current);
  if (next && stageRank(derived.stage) >= stageRank(next)) {
    return {
      from: current,
      to: next,
      transition: { from: current, to: next },
      missing: nextStage(next) ? requirementsFor(nextStage(next)!, facts) : [],
    };
  }
  return { from: current, to: current, missing: derived.missing };
}

// Every step the facts allow from the current stage, in order.
export function advanceStage(current: CaseStage, facts: CaseFacts): StageStep[] {
  const steps: StageStep[] = [];
  let stage = current;
  for (;;) {
    const step = stepStage(stage, facts);
    steps.push(step);
    if (!step.transition) return steps;
    stage = step.to;
  }
}

export interface SyncedStage {
  readonly caseId: string;
  readonly before: CaseStage;
  readonly after: CaseStage;
  readonly steps: readonly StageStep[];
}

// Re-derives a case's stage from its timeline and writes it, forward only. Artefacts
// are not stored yet (they arrive with their own table); until then a case cannot
// reach documented, which is the rule working as intended rather than a gap in it.
export async function syncCaseStage(
  connection: Connection,
  tenantId: string,
  caseId: string,
  artefacts: readonly ArtefactFact[] = [],
): Promise<SyncedStage> {
  return withTenant(connection, tenantId, async (db) => {
    const [row] = await db
      .select({ stage: cases.stage })
      .from(cases)
      .where(eq(cases.id, caseId))
      .limit(1);
    if (!row) throw new Error(`no case ${caseId}`);
    const before = row.stage as CaseStage;
    const events = await caseTimeline(db, caseId);
    const steps = advanceStage(before, { events, artefacts });
    const after = steps[steps.length - 1]!.to;
    if (after !== before) await db.update(cases).set({ stage: after }).where(eq(cases.id, caseId));
    return { caseId, before, after, steps };
  });
}
