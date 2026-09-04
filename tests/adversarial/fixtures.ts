import {
  sha256,
  type Case,
  type Evidence,
  type Finding,
  type UntrustedContent,
} from '@gc/contracts';
import { loadCatalogue } from '@gc/remedies';

// The remedy's current catalogue version: what the seed writes and a finding references.
const remedyVersion = (id: string): number => {
  const entry = loadCatalogue().get(id);
  if (!entry) throw new Error(`no remedy ${id}`);
  return entry.remedy.version;
};

// Typed objects the adversarial suites feed the model client: a case, a finding, the
// evidence behind it, and a helper that wraps scraped text the way the scanner does.

export const NOW = '2026-09-04T09:14:00Z';
export const DOMAIN = 'injected.shop.test';

export const CASE: Case = {
  id: 'DK-26-0M4K',
  tenantId: 't-1',
  company: { domain: DOMAIN, country: 'DK', locale: 'da' },
  jurisdiction: 'DK',
  locale: 'da',
  openedAt: NOW,
  participants: 1,
  watched: false,
  lane: 'self-serve',
  laneScore: 10,
  stage: 'opened',
};

export const EVIDENCE: Evidence = {
  id: 'ev-1',
  tenantId: 't-1',
  caseId: CASE.id,
  kind: 'http_request',
  capturedAt: NOW,
  source: { host: DOMAIN, path: '/', pass: 'A' },
  body: 'GET https://analytics.tracker.test/tag.js 200 on pass A',
  hash: sha256('GET https://analytics.tracker.test/tag.js 200 on pass A'),
};

export const FINDING: Finding = {
  id: 'f-1',
  tenantId: 't-1',
  caseId: CASE.id,
  typeId: 'CNS-09',
  fingerprint: `CNS-09|${DOMAIN}|/|`,
  jurisdiction: 'DK',
  binding: {
    findingTypeId: 'CNS-09',
    jurisdiction: 'DK',
    citations: [
      { kind: 'provision', instrument: 'ePrivacy', article: '5', paragraph: '3', ref: 'Art. 5(3)' },
    ],
    authority: { name: 'Datatilsynet' },
    guideId: 'cns-09',
    version: 1,
  },
  severity: 'serious',
  status: 'open',
  area: 'Consent',
  evidence: [{ evidenceId: EVIDENCE.id, hash: EVIDENCE.hash }],
  remedy: { remedyId: 'cns-09-new-tracker', version: remedyVersion('cns-09-new-tracker') },
  firstSeenAt: NOW,
  lastSeenAt: NOW,
};

export function untrusted(description: string, text: string, url?: string): UntrustedContent {
  return {
    trust: 'untrusted',
    source: { description, fetchedAt: NOW, ...(url ? { url } : { host: DOMAIN }) },
    mediaType: 'text/plain',
    hash: sha256(text),
    text,
  };
}
