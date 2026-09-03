import { describe, expect, it } from 'vitest';
import {
  FINDING_AREAS,
  FindingSchema,
  FindingTypeIdSchema,
  FindingTypeSchema,
  JurisdictionBindingSchema,
  SEVERITIES,
  UndeterminedCheckSchema,
  findingFingerprint,
} from '@gc/contracts';
import { binding, finding, without } from './helpers.js';

describe('Finding', () => {
  it('accepts a complete finding', () => {
    expect(FindingSchema.safeParse(finding()).success).toBe(true);
  });

  it('cannot be constructed without a remedy reference (R-02)', () => {
    const r = FindingSchema.safeParse(without(finding(), 'remedy'));
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.path.join('.'))).toContain('remedy');
  });

  it('cannot be constructed without evidence (A-07)', () => {
    expect(FindingSchema.safeParse(finding({ evidence: [] })).success).toBe(false);
    expect(FindingSchema.safeParse(without(finding(), 'evidence')).success).toBe(false);
  });

  it('requires a jurisdiction-scoped binding that matches the finding', () => {
    expect(FindingSchema.safeParse(without(finding(), 'binding')).success).toBe(false);

    const wrongJurisdiction = FindingSchema.safeParse(
      finding({ binding: binding({ jurisdiction: 'DE' }) }),
    );
    expect(wrongJurisdiction.success).toBe(false);
    expect(wrongJurisdiction.error?.issues[0]?.path).toEqual(['binding', 'jurisdiction']);

    const wrongType = FindingSchema.safeParse(
      finding({ binding: binding({ findingTypeId: 'CNS-03' }) }),
    );
    expect(wrongType.success).toBe(false);
    expect(wrongType.error?.issues[0]?.path).toEqual(['binding', 'findingTypeId']);
  });

  it('a binding names at least one citation', () => {
    expect(JurisdictionBindingSchema.safeParse(binding({ citations: [] })).success).toBe(false);
  });

  it('severity is one of three values from the rule table', () => {
    expect(SEVERITIES).toEqual(['blocking', 'serious', 'advisory']);
    expect(FindingSchema.safeParse(finding({ severity: 'critical' as never })).success).toBe(false);
  });

  it('has a stable type id of the form AREA-NN', () => {
    for (const ok of ['CNS-02', 'AI-03', 'POL-11', 'SEC-02']) {
      expect(FindingTypeIdSchema.safeParse(ok).success).toBe(true);
    }
    for (const bad of ['cns-02', 'CNS02', 'CNS-2', 'Art. 5(3)', '']) {
      expect(FindingTypeIdSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('fingerprint is deterministic and distinguishes subjects', () => {
    expect(findingFingerprint('CNS-02', { host: 'a.dk' })).toBe(
      findingFingerprint('CNS-02', { host: 'a.dk' }),
    );
    expect(findingFingerprint('CNS-02', { host: 'a.dk' })).not.toBe(
      findingFingerprint('CNS-02', { host: 'b.dk' }),
    );
    expect(findingFingerprint('CNS-02')).toBe('CNS-02|||');
  });

  it('closedAt and status agree', () => {
    expect(FindingSchema.safeParse(finding({ status: 'closed' })).success).toBe(false);
    expect(
      FindingSchema.safeParse(finding({ status: 'open', closedAt: '2026-09-04T00:00:00Z' }))
        .success,
    ).toBe(false);
    expect(
      FindingSchema.safeParse(finding({ status: 'closed', closedAt: '2026-09-04T00:00:00Z' }))
        .success,
    ).toBe(true);
  });

  it('the area list is the eight areas of the case page', () => {
    expect(FINDING_AREAS).toHaveLength(8);
    expect(FindingSchema.safeParse(finding({ area: 'Marketing' as never })).success).toBe(false);
  });
});

describe('FindingType (I-02)', () => {
  it('is a stable identity with no legal binding on it', () => {
    const keys = Object.keys(FindingTypeSchema.shape);
    for (const forbidden of ['article', 'citations', 'authority', 'instrument', 'jurisdiction']) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('carries translatable text with English mandatory', () => {
    const base = {
      id: 'CNS-02',
      area: 'Consent',
      defaultSeverity: 'blocking',
      detector: 'consent/reject-not-honoured',
      version: 1,
    };
    expect(
      FindingTypeSchema.safeParse({ ...base, title: { en: 'x' }, summary: { en: 'y', da: 'z' } })
        .success,
    ).toBe(true);
    expect(
      FindingTypeSchema.safeParse({ ...base, title: { da: 'x' }, summary: { en: 'y' } }).success,
    ).toBe(false);
  });
});

describe('UndeterminedCheck', () => {
  it('is an outcome with a reason and a way to resolve it', () => {
    expect(
      UndeterminedCheckSchema.safeParse({
        id: 'u-1',
        caseId: 'DK-26-0M4K',
        typeId: 'POL-11',
        reason: 'The wording is ambiguous about the legal basis.',
        resolvedBy: 'question',
        questionId: 'Q3',
      }).success,
    ).toBe(true);
    expect(
      UndeterminedCheckSchema.safeParse({
        id: 'u-1',
        caseId: 'DK-26-0M4K',
        typeId: 'POL-11',
        resolvedBy: 'question',
      }).success,
    ).toBe(false);
  });
});
