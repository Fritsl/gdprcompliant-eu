import { describe, expect, it } from 'vitest';
import {
  AdequacyListSchema,
  DpfLookupsSchema,
  PassCaptureSchema,
  TransferDeterminationSchema,
  type PassCapture,
  type VendorRegistryEntry,
} from '@gc/contracts';
import { bannedClaims, loadClaimVocabulary } from '@gc/i18n';
import {
  auditTransferData,
  chapterVBasis,
  determineTransfer,
  loadAdequacy,
  loadDpfLookups,
  recipientChecks,
  situationOf,
  staleTransferData,
  transferMaps,
} from '@gc/scanner';

// Transfer and jurisdiction determination (S-08): the adequacy list and the DPF lookups
// are dated data; a determination says where the contracting entity and its parent sit,
// tells "hosted inside the EEA" from "controlled from outside it", reads the policy for
// a Chapter V basis, and never passes a verdict on a named company.

const maps = transferMaps();
const vocab = loadClaimVocabulary();
const entry = (id: string): VendorRegistryEntry => maps.registry.vendors.find((v) => v.id === id)!;

describe('the lists', () => {
  it('the adequacy list is dated, sourced and reviewed, and the United States entry is DPF-scoped', () => {
    const list = loadAdequacy();
    expect(AdequacyListSchema.safeParse(list).success).toBe(true);
    expect(list.source).toMatch(/^https:\/\/commission\.europa\.eu\//);
    expect(list.decisions.length).toBeGreaterThanOrEqual(14);
    expect(new Set(list.decisions.map((d) => d.country)).size).toBe(list.decisions.length);
    const us = list.decisions.find((d) => d.country === 'US')!;
    expect(us.dpf).toBe(true);
    expect(us.scope).toMatch(/Data Privacy Framework/);
    expect(list.decisions.find((d) => d.country === 'CH')).toBeDefined();
  });

  it('every vendor with a United States entity has a DPF lookup with the day it was made, or says it was not checked', () => {
    const dpf = loadDpfLookups();
    expect(DpfLookupsSchema.safeParse(dpf).success).toBe(true);
    expect(dpf.source).toBe('https://www.dataprivacyframework.gov/list');
    expect(auditTransferData(maps)).toEqual([]);
    for (const l of dpf.lookups) {
      if (l.status === 'not_checked') continue;
      expect(l.lookedUpAt, l.vendorId).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (l.status !== 'not_listed') expect(l.organisation, l.vendorId).toBeTruthy();
    }
    expect(dpf.lookups.find((l) => l.vendorId === 'google')).toMatchObject({
      organisation: 'Google LLC',
      status: 'active',
    });
  });

  it('a stale lookup or an overdue list is named, and today neither is', () => {
    expect(staleTransferData(maps, new Date('2026-09-04T12:00:00Z'))).toEqual([]);
    const later = staleTransferData(maps, new Date('2027-06-01T00:00:00Z'));
    expect(later.some((s) => s.what === 'adequacy list')).toBe(true);
    expect(later.some((s) => s.what === 'DPF lookup google')).toBe(true);
  });
});

describe('a determination', () => {
  it('tells an EEA entity with a non-EEA parent from a non-EEA entity, and from a vendor inside the EEA', () => {
    expect(situationOf(entry('google'))).toBe('eea_entity_non_eea_parent');
    expect(situationOf(entry('klaviyo'))).toBe('non_eea_entity');
    expect(situationOf(entry('cookiebot'))).toBe('inside_eea');
    expect(situationOf(entry('hotjar'))).toBe('inside_eea');
  });

  it('for an EEA entity controlled from the United States: both places, the list, the DPF status and the date', () => {
    const d = determineTransfer(entry('google'), { maps, policyText: undefined });
    expect(TransferDeterminationSchema.safeParse(d).success).toBe(true);
    expect(d).toMatchObject({
      situation: 'eea_entity_non_eea_parent',
      contracting: { name: 'Google Ireland Limited', country: 'IE', inEea: true },
      parent: { name: 'Alphabet Inc.', country: 'US', inEea: false },
      adequacy: { country: 'US', listed: true, verifiedAt: maps.adequacy.verifiedAt },
      dpf: { status: 'active', organisation: 'Google LLC', lookedUpAt: '2026-09-04' },
      policyBasis: { outcome: 'no_policy', terms: [] },
    });
    expect(d.statement.en).toContain('established inside the EEA');
    expect(d.statement.en).toContain('is established outside it');
    expect(d.statement.en).toContain('controlled from outside the EEA');
    expect(d.statement.en).toContain('Google LLC was listed as an active participant');
    expect(d.statement.en).toContain('read on 2026-09-04');
    expect(d.statement.en).toContain('No privacy policy was found');
    expect(d.statement.da).toContain('inden for EØS');
    expect(d.statement.da).toContain('styres fra et land uden for EØS');
  });

  it('for a non-EEA entity: outside, with the list read and the DPF status', () => {
    const d = determineTransfer(entry('klaviyo'), {
      maps,
      policyText:
        'We transfer data to the US under the EU-U.S. Data Privacy Framework and standard contractual clauses.',
    });
    expect(d).toMatchObject({
      situation: 'non_eea_entity',
      adequacy: { country: 'US', listed: true },
      dpf: { status: 'active', organisation: 'Klaviyo, Inc.' },
      policyBasis: { outcome: 'named' },
    });
    expect(d.policyBasis.terms).toEqual([
      'EU-U.S. Data Privacy Framework',
      'standard contractual clauses',
    ]);
    expect(d.statement.en).toContain('is established outside the EEA');
    expect(d.statement.en).not.toContain('controlled from outside');
    expect(d.statement.en).toContain('names a Chapter V basis: “EU-U.S. Data Privacy Framework”');
  });

  it('for a country without an adequacy decision: the list is named as read, and the DPF is not mentioned', () => {
    const d = determineTransfer(
      { ...entry('tiktok'), parent: { name: 'ByteDance Ltd.', country: 'KY' } },
      { maps, policyText: 'Vi overfører oplysninger på grundlag af standardkontraktbestemmelser.' },
    );
    expect(d).toMatchObject({
      situation: 'eea_entity_non_eea_parent',
      adequacy: { country: 'KY', listed: false },
      policyBasis: { outcome: 'named', terms: ['standardkontraktbestemmelser'] },
    });
    expect(d.dpf).toBeUndefined();
    expect(d.statement.en).toContain('does not include Cayman Islands');
    expect(d.statement.da).toContain('omfatter ikke Caymanøerne');
  });

  it('inside the EEA: one sentence, no list, no DPF, no policy question', () => {
    const d = determineTransfer(entry('cookiebot'), { maps });
    expect(d.situation).toBe('inside_eea');
    expect(d.adequacy).toBeUndefined();
    expect(d.dpf).toBeUndefined();
    expect(d.statement.en).toBe(
      'The contracting entity, Usercentrics A/S (Denmark), is established inside the EEA, and so is its parent, Usercentrics GmbH (Germany).',
    );
  });

  it('the policy read finds Chapter V terms in English and Danish, and says so when there is nothing', () => {
    expect(chapterVBasis(undefined)).toEqual({ outcome: 'no_policy', terms: [] });
    expect(chapterVBasis('We keep your data safe.')).toEqual({ outcome: 'not_named', terms: [] });
    expect(
      chapterVBasis(
        'Overførsler sker efter en tilstrækkelighedsafgørelse eller bindende virksomhedsregler.',
      ).terms,
    ).toEqual(['tilstrækkelighedsafgørelse', 'bindende virksomhedsregler']);
    expect(chapterVBasis('see Article 46 GDPR').terms).toEqual(['Article 46']);
  });

  it('never passes a verdict on a named company, in either language', () => {
    for (const v of maps.registry.vendors) {
      for (const policyText of [undefined, 'standard contractual clauses', 'nothing here']) {
        const d = determineTransfer(v, {
          maps,
          ...(policyText !== undefined ? { policyText } : {}),
        });
        expect(bannedClaims(d.statement.en, 'en', vocab), `${v.id} en`).toEqual([]);
        expect(bannedClaims(d.statement.da, 'da', vocab), `${v.id} da`).toEqual([]);
        expect(d.statement.en).not.toMatch(/\b(should|must|may not)\b/);
      }
    }
  });
});

describe('the transfer finding carries the determination', () => {
  const identity = {
    tenantId: 't-1',
    caseId: 'DK-26-0M4K',
    scanId: 'scan-1',
    capturedAt: '2026-09-04T09:14:00Z',
  };
  const request = (url: string) => {
    const u = new URL(url);
    return {
      url,
      host: u.hostname,
      method: 'GET',
      resourceType: 'script' as const,
      frameUrl: 'https://eksempelbutik.test/',
      initiator: { type: 'parser' as const },
      chain: [],
      startedAtMs: 10,
    };
  };
  const capture: PassCapture = PassCaptureSchema.parse({
    pass: 'A',
    url: 'https://eksempelbutik.test/',
    finalUrl: 'https://eksempelbutik.test/',
    status: 200,
    startedAt: identity.capturedAt,
    frames: [],
    requests: [
      request('https://eksempelbutik.test/'),
      request('https://www.googletagmanager.com/gtm.js?id=GTM-1'),
      request('https://static.klaviyo.com/onsite/js/klaviyo.js'),
      request('https://cdn.ukendt.test/x.js'),
    ],
    cookies: [],
    storage: [],
    quiet: {
      minDwellMs: 0,
      quietMs: 0,
      maxWaitMs: 0,
      dwellMs: 0,
      lastRequestAtMs: 0,
      settled: true,
    },
  });

  it('names each recipient outside the EEA with where its entities sit, in the finding text and its detail', () => {
    const { observations } = recipientChecks(capture, identity, {
      policyText: 'Vi overfører oplysninger til USA efter EU-U.S. Data Privacy Framework.',
    });
    const transfers = observations.find((o) => o.check === 'transfers')!;
    expect(transfers.outcome).toBe('fail');
    expect(transfers.hosts).toEqual(['static.klaviyo.com', 'www.googletagmanager.com']);
    const outside = transfers.detail['outside'] as {
      host: string;
      determination?: { situation: string; statement: { en: string } };
    }[];
    expect(outside.map((o) => [o.host, o.determination?.situation])).toEqual([
      ['static.klaviyo.com', 'non_eea_entity'],
      ['www.googletagmanager.com', 'eea_entity_non_eea_parent'],
    ]);
    expect(transfers.summary).toContain(
      'Google Ireland Limited (Ireland), is established inside the EEA',
    );
    expect(transfers.summary).toContain(
      'Klaviyo, Inc. (United States), is established outside the EEA',
    );
    expect(transfers.summary).toContain(
      'names a Chapter V basis: “EU-U.S. Data Privacy Framework”',
    );
    // The unknown host is not a transfer finding: nothing is said about it here, and
    // the vendor row keeps it as unresolved with the host shown.
    expect(transfers.summary).not.toContain('ukendt');
    expect(bannedClaims(transfers.summary, 'en', vocab)).toEqual([]);
  });
});
