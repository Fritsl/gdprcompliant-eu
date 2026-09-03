import type {
  Citation,
  Evidence,
  EvidenceRef,
  Finding,
  JurisdictionBinding,
  RemedyRef,
} from '@gc/contracts';

// Minimal valid objects. Tests override one field at a time so a failure names the rule
// it broke, not the fixture it borrowed.

export const HASH = 'a'.repeat(64);
export const NOW = '2026-09-03T09:14:00Z';
export const CASE_ID = 'DK-26-0M4K';

export const evidenceRef = (over: Partial<EvidenceRef> = {}): EvidenceRef => ({
  evidenceId: 'ev-1',
  hash: HASH,
  ...over,
});

export const evidence = (over: Partial<Evidence> = {}): Evidence => ({
  id: 'ev-1',
  tenantId: 't-1',
  caseId: CASE_ID,
  kind: 'pass_diff',
  capturedAt: NOW,
  source: { host: 'eksempelbutik.dk', pass: 'B' },
  body: 'connect.facebook.net loaded loaded identical',
  hash: HASH,
  ...over,
});

export const citation = (over: Partial<Citation> = {}): Citation =>
  ({
    kind: 'provision',
    instrument: 'ePrivacy',
    article: '5',
    paragraph: '3',
    ref: 'Art. 5(3)',
    ...over,
  }) as Citation;

export const binding = (over: Partial<JurisdictionBinding> = {}): JurisdictionBinding => ({
  findingTypeId: 'CNS-02',
  jurisdiction: 'DK',
  citations: [citation()],
  authority: { name: 'Datatilsynet' },
  guideId: 'reject-not-honoured',
  version: 1,
  ...over,
});

export const remedyRef = (over: Partial<RemedyRef> = {}): RemedyRef => ({
  remedyId: 'rem-cns-02',
  version: 1,
  ...over,
});

export const finding = (over: Partial<Finding> = {}): Finding => ({
  id: 'f-1',
  tenantId: 't-1',
  caseId: CASE_ID,
  typeId: 'CNS-02',
  fingerprint: 'CNS-02|eksempelbutik.dk||',
  jurisdiction: 'DK',
  binding: binding(),
  severity: 'blocking',
  status: 'open',
  area: 'Consent',
  evidence: [evidenceRef()],
  remedy: remedyRef(),
  firstSeenAt: NOW,
  lastSeenAt: NOW,
  ...over,
});

// Strip a key from an object so a test can prove the key is required.
export function without<T extends object, K extends keyof T>(obj: T, key: K): Omit<T, K> {
  const copy = { ...obj };
  delete copy[key];
  return copy;
}
