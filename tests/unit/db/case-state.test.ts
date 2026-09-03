import { describe, expect, it } from 'vitest';
import { CASE_STAGES, CaseEventSchema, type CaseEvent, type CaseStage } from '@gc/contracts';
import {
  CASE_TRANSITIONS,
  DOCUMENTED_REQUIRES,
  RESTING_STAGE,
  advanceStage,
  canTransition,
  deriveStage,
  stepStage,
  type CaseFacts,
} from '@gc/db';

// The case state machine (C-03): every pair of stages tried against the declared
// transitions, the stage derived from facts rather than set, one step at a time, never
// backwards without saying so, and watched as the place a case rests.

let seq = 0;
const ev = (type: CaseEvent['type'], payload: object): CaseEvent =>
  CaseEventSchema.parse({
    id: `DK-26-0M4K:${++seq}`,
    tenantId: 't',
    caseId: 'DK-26-0M4K',
    seq,
    at: '2026-09-03T09:14:00Z',
    actor: { kind: 'scanner' },
    type,
    payload,
  });

const scanned = ev('scan_completed', {
  scanId: 's1',
  checksRun: 23,
  checksPassed: 11,
  findings: 12,
  undetermined: 0,
});
const closed = ev('finding_closed', { findingId: 'f1', verifiedBy: 'rescan' });
const published = DOCUMENTED_REQUIRES.map((kind) =>
  ev('artefact_published', { artefactId: `a-${kind}`, kind }),
);
const watched = ev('watch_run', { scanId: 's2', changes: 0 });
const existing = DOCUMENTED_REQUIRES.map((kind) => ({ kind, published: true }));

const facts = (events: CaseEvent[], artefacts: CaseFacts['artefacts'] = []): CaseFacts => ({
  events,
  artefacts,
});

describe('the transitions, exhaustively', () => {
  it('is one chain: each stage moves to exactly the next one, and watched moves nowhere', () => {
    for (const from of CASE_STAGES) {
      for (const to of CASE_STAGES) {
        const expected = CASE_STAGES.indexOf(to) === CASE_STAGES.indexOf(from) + 1;
        expect(canTransition(from, to), `${from} → ${to}`).toBe(expected);
      }
    }
    expect(CASE_TRANSITIONS.watched).toEqual([]);
    expect(RESTING_STAGE).toBe('watched');
    expect(CASE_STAGES).toEqual(['opened', 'assessed', 'working', 'documented', 'watched']);
    expect(CASE_STAGES.some((s) => /closed|done|final|archived/.test(s))).toBe(false);
  });
});

describe('deriving the stage from facts', () => {
  it('walks the chain as far as the facts carry it, and says what the next stage needs', () => {
    expect(deriveStage(facts([]))).toEqual({
      stage: 'opened',
      next: 'assessed',
      missing: ['no scan has completed'],
    });
    expect(deriveStage(facts([scanned]))).toMatchObject({ stage: 'assessed', next: 'working' });
    expect(deriveStage(facts([scanned, closed]))).toMatchObject({
      stage: 'working',
      next: 'documented',
      missing: DOCUMENTED_REQUIRES.map((k) => `${k} is not published`),
    });
  });

  it('documented needs the artefacts to exist, not just an event saying they were published', () => {
    expect(deriveStage(facts([scanned, closed, ...published]))).toMatchObject({
      stage: 'working',
      missing: DOCUMENTED_REQUIRES.map((k) => `${k} is not published`),
    });
    expect(deriveStage(facts([scanned, closed], existing))).toMatchObject({ stage: 'working' });
    const twoOfThree = existing.slice(0, 2);
    expect(deriveStage(facts([scanned, closed, ...published], twoOfThree))).toMatchObject({
      stage: 'working',
      missing: [`${DOCUMENTED_REQUIRES[2]} is not published`],
    });
    expect(deriveStage(facts([scanned, closed, ...published], existing))).toMatchObject({
      stage: 'documented',
      next: 'watched',
      missing: ['no weekly check has run'],
    });
    expect(deriveStage(facts([scanned, closed, ...published, watched], existing))).toEqual({
      stage: 'watched',
      missing: [],
    });
  });

  it('a scan alone does not make a case working; a closed finding or an answer does', () => {
    expect(deriveStage(facts([scanned])).stage).toBe('assessed');
    expect(
      deriveStage(facts([scanned, ev('question_answered', { questionId: 'q1', answer: 'yes' })]))
        .stage,
    ).toBe('working');
    // Events out of order do not matter; facts are facts.
    expect(deriveStage(facts([closed, scanned])).stage).toBe('working');
    // Work without a scan is not assessed, so not working either: the chain holds.
    expect(deriveStage(facts([closed])).stage).toBe('opened');
  });
});

describe('stepping', () => {
  const everything = facts([scanned, closed, ...published, watched], existing);

  it('moves one declared transition at a time, never a skip', () => {
    const first = stepStage('opened', everything);
    expect(first).toMatchObject({
      from: 'opened',
      to: 'assessed',
      transition: { from: 'opened', to: 'assessed' },
    });
    const all = advanceStage('opened', everything);
    expect(all.map((s) => s.to)).toEqual([
      'assessed',
      'working',
      'documented',
      'watched',
      'watched',
    ]);
    expect(all.filter((s) => s.transition).length).toBe(4);
    for (const s of all.filter((x) => x.transition)) expect(canTransition(s.from, s.to)).toBe(true);
  });

  it('stays put when the facts stop short, and says what is missing', () => {
    const step = stepStage('assessed', facts([scanned]));
    expect(step).toEqual({
      from: 'assessed',
      to: 'assessed',
      missing: ['no finding has been closed and no question answered'],
    });
  });

  it('never goes backwards silently: a lost requirement is reported, the stage kept', () => {
    const step = stepStage('documented', facts([scanned, closed, ...published]));
    expect(step.to).toBe('documented');
    expect(step.transition).toBeUndefined();
    expect(step.regression).toEqual({
      from: 'documented',
      derived: 'working',
      because: DOCUMENTED_REQUIRES.map((k) => `${k} is not published`),
    });
    const resting = stepStage('watched', facts([]));
    expect(resting).toMatchObject({ to: 'watched', regression: { derived: 'opened' } });
  });

  it('watched is where a case rests: more facts change nothing, and there is nowhere further', () => {
    const more = facts(
      [...everything.events, watched, closed, ev('finding_regressed', { findingId: 'f1' })],
      existing,
    );
    expect(stepStage('watched', more)).toEqual({ from: 'watched', to: 'watched', missing: [] });
    expect(advanceStage('watched', more).length).toBe(1);
  });
});

describe('every stage in the enum is reachable through the chain', () => {
  it('and only through it', () => {
    const reached = new Set<CaseStage>(['opened']);
    for (const s of advanceStage(
      'opened',
      facts([scanned, closed, ...published, watched], existing),
    )) {
      reached.add(s.to);
    }
    expect([...reached]).toEqual([...CASE_STAGES]);
  });
});
