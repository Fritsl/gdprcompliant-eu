import { describe, expect, it } from 'vitest';
import { ClaimSchema, VerifierVerdictSchema } from '@gc/contracts';
import { CASE_ID, NOW, citation, evidenceRef } from './helpers.js';

const observation = {
  id: 'c-1',
  caseId: CASE_ID,
  kind: 'observation',
  statement: 'connect.facebook.net loads on pass B',
  evidence: [evidenceRef({ quote: 'connect.facebook.net' })],
  producedBy: { worker: 'crawler' },
  at: NOW,
};

describe('Claim (A-05, A-07)', () => {
  it('an observation needs evidence', () => {
    expect(ClaimSchema.safeParse(observation).success).toBe(true);
    expect(ClaimSchema.safeParse({ ...observation, evidence: [] }).success).toBe(false);
  });

  it('a legal claim needs a citation and a jurisdiction to resolve it in', () => {
    const legal = {
      ...observation,
      kind: 'legal',
      statement: 'Consent is required before storage.',
    };
    const r = ClaimSchema.safeParse(legal);
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.path.join('.'))).toEqual(
      expect.arrayContaining(['citations', 'jurisdiction']),
    );
    expect(
      ClaimSchema.safeParse({ ...legal, citations: [citation()], jurisdiction: 'DK' }).success,
    ).toBe(true);
  });

  it('names who produced it', () => {
    expect(ClaimSchema.safeParse({ ...observation, producedBy: { worker: '' } }).success).toBe(
      false,
    );
  });
});

describe('VerifierVerdict (A-07)', () => {
  const accepted = {
    claimId: 'c-1',
    verdict: 'accepted',
    checks: [
      { name: 'evidence_exists', passed: true },
      { name: 'quote_matches_source', passed: true },
    ],
    at: NOW,
  };

  it('accepts when every check passed', () => {
    expect(VerifierVerdictSchema.safeParse(accepted).success).toBe(true);
  });

  it('cannot accept over a failed check', () => {
    expect(
      VerifierVerdictSchema.safeParse({
        ...accepted,
        checks: [{ name: 'citation_resolves', passed: false }],
      }).success,
    ).toBe(false);
  });

  it('a rejection is recorded with a reason', () => {
    const rejected = {
      ...accepted,
      verdict: 'rejected',
      checks: [{ name: 'citation_resolves', passed: false }],
    };
    expect(VerifierVerdictSchema.safeParse(rejected).success).toBe(false);
    expect(VerifierVerdictSchema.safeParse({ ...rejected, reason: '   ' }).success).toBe(false);
    expect(
      VerifierVerdictSchema.safeParse({
        ...rejected,
        reason: 'GDPR:99 does not exist in the corpus',
      }).success,
    ).toBe(true);
  });

  it('runs at least one check', () => {
    expect(VerifierVerdictSchema.safeParse({ ...accepted, checks: [] }).success).toBe(false);
    expect(
      VerifierVerdictSchema.safeParse({ ...accepted, checks: [{ name: 'vibes', passed: true }] })
        .success,
    ).toBe(false);
  });
});
