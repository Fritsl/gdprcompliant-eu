import { describe, expect, it } from 'vitest';
import { CASE_EVENT_TYPES, CaseEventSchema, CaseSchema } from '@gc/contracts';
import { CASE_ID, NOW } from './helpers.js';

const base = { id: 'e-1', tenantId: 't-1', caseId: CASE_ID, seq: 1, at: NOW };

describe('CaseEvent (C-02)', () => {
  it('event types are a closed enum', () => {
    expect(CASE_EVENT_TYPES.length).toBeGreaterThanOrEqual(20);
    expect(new Set(CASE_EVENT_TYPES).size).toBe(CASE_EVENT_TYPES.length);
    expect(CASE_EVENT_TYPES).toContain('case_opened');
    expect(CASE_EVENT_TYPES).toContain('finding_closed');
    expect(CASE_EVENT_TYPES).toContain('claim_rejected');

    const unknown = CaseEventSchema.safeParse({
      ...base,
      actor: { kind: 'system' },
      type: 'something_happened',
      payload: {},
    });
    expect(unknown.success).toBe(false);
  });

  it('every event names its actor', () => {
    const noActor = CaseEventSchema.safeParse({
      ...base,
      type: 'case_opened',
      payload: { source: 'scanner' },
    });
    expect(noActor.success).toBe(false);

    const anonymous = CaseEventSchema.safeParse({
      ...base,
      actor: { kind: 'person', userId: 'u-1' },
      type: 'note_added',
      payload: { text: 'hello' },
    });
    expect(anonymous.success).toBe(false);

    const named = CaseEventSchema.safeParse({
      ...base,
      actor: { kind: 'person', userId: 'u-1', name: 'Mette' },
      type: 'note_added',
      payload: { text: 'hello' },
    });
    expect(named.success).toBe(true);
  });

  it('payloads are typed per event', () => {
    const ok = CaseEventSchema.safeParse({
      ...base,
      actor: { kind: 'scanner' },
      type: 'finding_raised',
      payload: { findingId: 'f-1', typeId: 'CNS-02', severity: 'blocking' },
    });
    expect(ok.success).toBe(true);

    const wrongPayload = CaseEventSchema.safeParse({
      ...base,
      actor: { kind: 'scanner' },
      type: 'finding_raised',
      payload: { findingId: 'f-1' },
    });
    expect(wrongPayload.success).toBe(false);
  });

  it('is ordered by a positive sequence number', () => {
    expect(
      CaseEventSchema.safeParse({
        ...base,
        seq: 0,
        actor: { kind: 'watcher' },
        type: 'watch_run',
        payload: { scanId: 's', changes: 0 },
      }).success,
    ).toBe(false);
  });
});

describe('Case', () => {
  it('parses a self-serve case', () => {
    expect(
      CaseSchema.safeParse({
        id: CASE_ID,
        tenantId: 't-1',
        company: { domain: 'eksempelbutik.dk', country: 'DK', locale: 'da' },
        jurisdiction: 'DK',
        locale: 'da',
        openedAt: NOW,
        participants: 4,
        watched: true,
        lane: 'self-serve',
        laneScore: 34,
        stage: 'working',
      }).success,
    ).toBe(true);
  });

  it('case numbers read as country, year, four characters', () => {
    expect(CaseSchema.shape.id.safeParse('DE-26-1QR8').success).toBe(true);
    expect(CaseSchema.shape.id.safeParse('dk-26-0m4k').success).toBe(false);
    expect(CaseSchema.shape.id.safeParse('DK-2026-0M4K').success).toBe(false);
  });
});
