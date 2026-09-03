import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ActionSchema,
  CompanySchema,
  DemandLedgerEntrySchema,
  FindingSchema,
  REMEDY_KINDS,
  RenderedRemedySchema,
  VendorSchema,
  citationKey,
  parseProvisionRef,
  type ArtefactKind,
  type Citation,
  type Finding,
  type FindingArea,
  type FindingStatus,
  type RenderedRemedy,
  type Severity,
  type Vendor,
} from '@gc/contracts';
import { HASH, NOW } from './helpers.js';

// The phase 0 fixture is the contract's shape, seen from the customer's side. This test
// walks it into the domain schemas so the two cannot drift: a new remedy kind, action
// kind, severity or area in the prototype must exist here, and vice versa.

type FixtureCitation = { instrument: string; ref: string; note?: string };
type FixtureRemedy = Record<string, unknown> & {
  kind: string;
  title: string;
  effort: string;
  detail: string;
};
type FixtureFinding = {
  id: string;
  title: string;
  severity: string;
  area: string;
  closesIn: string | null;
  why: string;
  citations: FixtureCitation[];
  evidence: { kind: string };
  remedy: FixtureRemedy;
};
type Fixture = {
  company: Record<string, unknown>;
  findings: FixtureFinding[];
  newInWatch: FixtureFinding;
  demandLedger: { gap: string; seen: number; sectors: string; answer: string }[];
  supplyChain: {
    nodes: { id: string; label: string; level: number; juris: string; parent?: string }[];
    edges: [string, string][];
  };
  articles: Record<string, { ref: string; text: string }>;
};

const fixture = JSON.parse(
  readFileSync(new URL('../../../fixtures/companies/eksempelbutik.json', import.meta.url), 'utf8'),
) as Fixture;

const allFindings = [...fixture.findings, fixture.newInWatch];

const ARTEFACT_BY_FINDING: Record<string, ArtefactKind> = {
  'DPA-01': 'processing_agreement',
  'POL-04': 'privacy_policy',
  'POL-09': 'privacy_policy',
  'SUB-03': 'sub_processor_list',
};

function toCitation(c: FixtureCitation): Citation | undefined {
  if (c.instrument === 'Case law') {
    const [body, ...rest] = c.ref.split(', ');
    if (!body || rest.length === 0) return undefined;
    return {
      kind: 'decision',
      body,
      reference: rest.join(', '),
      ref: c.ref,
      ...(c.note ? { note: c.note } : {}),
    };
  }
  return parseProvisionRef(c.instrument, c.ref, c.note ? { note: c.note } : {});
}

function toRenderedRemedy(f: FixtureFinding): unknown {
  const r = f.remedy;
  const base: Record<string, unknown> = {
    id: `rem-${f.id}`,
    version: 1,
    findingTypeId: f.id,
    jurisdictions: 'all',
    locale: 'en',
    kind: r.kind,
    title: r.title,
    effort: { label: r.effort },
    detail: r.detail,
  };
  if (typeof r['verifyLabel'] === 'string') base['verifyLabel'] = r['verifyLabel'];
  if (r['action']) base['action'] = r['action'];
  switch (r.kind) {
    case 'self_fix':
      return { ...base, snippet: r['snippet'], verification: { method: 'rescan' } };
    case 'generated_artefact': {
      const artefact = ARTEFACT_BY_FINDING[f.id];
      return {
        ...base,
        artefact,
        cta: r['cta'],
        verification: { method: 'artefact_published', artefact },
      };
    }
    case 'our_product':
      return {
        ...base,
        product: { id: 'gdprchat', url: 'https://gdprchat.eu' },
        cta: r['cta'],
        alternativeNote: r['alternativeNote'],
        verification: { method: 'attestation', statement: r['verifyLabel'] },
      };
    case 'partner_alternative':
      return {
        ...base,
        options: (r['options'] as string[]).map((line) => {
          const m = /^(.*?), ([A-Z]{2}) — (.*)$/.exec(line);
          return { name: m?.[1], jurisdiction: m?.[2], note: m?.[3] };
        }),
        verification: { method: 'rescan' },
      };
    case 'no_solution':
      return {
        ...base,
        demandGap: fixture.demandLedger[0]?.gap,
        askLabel: r['askLabel'],
        verification: { method: 'none', reason: r.detail },
      };
    default:
      return base;
  }
}

const STATUS_BY_CLOSES_IN: Record<string, FindingStatus> = { working: 'working', watched: 'open' };

function toFinding(f: FixtureFinding): Finding {
  const citations = f.citations.map(toCitation).filter((c): c is Citation => c !== undefined);
  const evidence = [{ evidenceId: `ev-${f.id}`, hash: HASH }];
  return {
    id: `f-${f.id}`,
    tenantId: 't-eksempelbutik',
    caseId: 'DK-26-0M4K',
    typeId: f.id,
    fingerprint: `${f.id}|eksempelbutik.dk||`,
    jurisdiction: 'DK',
    binding: {
      findingTypeId: f.id,
      jurisdiction: 'DK',
      citations,
      authority: { name: 'Datatilsynet' },
      guideId: f.id.toLowerCase(),
      version: 1,
    },
    severity: f.severity as Severity,
    status: STATUS_BY_CLOSES_IN[f.closesIn ?? ''] ?? 'open',
    area: f.area as FindingArea,
    evidence,
    remedy: { remedyId: `rem-${f.id}`, version: 1 },
    explanation: { locale: 'en', why: f.why, evidence },
    firstSeenAt: NOW,
    lastSeenAt: NOW,
  };
}

describe('the phase 0 fixture fits the contracts', () => {
  it('every finding becomes a Finding', () => {
    for (const f of allFindings) {
      const r = FindingSchema.safeParse(toFinding(f));
      expect(
        r.success,
        `${f.id}: ${r.error?.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ')}`,
      ).toBe(true);
    }
  });

  it('every citation resolves to a mechanical key', () => {
    for (const f of allFindings) {
      for (const c of f.citations) {
        const parsed = toCitation(c);
        expect(parsed, `${f.id}: ${c.instrument} ${c.ref}`).toBeDefined();
        expect(citationKey(parsed!)).not.toBe('');
      }
    }
    for (const key of Object.keys(fixture.articles)) {
      const [instrument, ...ref] = key.split(' ');
      expect(parseProvisionRef(instrument ?? '', ref.join(' ')), key).toBeDefined();
    }
  });

  it('every remedy becomes a RenderedRemedy, and the fixture covers all five kinds', () => {
    const kinds = new Set<string>();
    for (const f of allFindings) {
      const r = RenderedRemedySchema.safeParse(toRenderedRemedy(f));
      expect(
        r.success,
        `${f.id}: ${r.error?.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ')}`,
      ).toBe(true);
      kinds.add((r.data as RenderedRemedy).kind);
    }
    expect([...kinds].sort()).toEqual([...REMEDY_KINDS].sort());
  });

  it('every drafted action is one of the one-click shapes', () => {
    for (const f of allFindings) {
      if (f.remedy['action']) {
        expect(ActionSchema.safeParse(f.remedy['action']).success, f.id).toBe(true);
      }
    }
  });

  it('the company parses', () => {
    expect(CompanySchema.safeParse(fixture.company).success).toBe(true);
  });

  it('the supply chain becomes Vendors', () => {
    const parentOf = new Map(fixture.supplyChain.edges.map(([from, to]) => [to, from]));
    for (const node of fixture.supplyChain.nodes.filter((n) => n.level > 0)) {
      const vendor: Vendor = {
        id: node.id,
        tenantId: 't-eksempelbutik',
        caseId: 'DK-26-0M4K',
        label: node.label,
        jurisdiction: node.juris,
        ...(node.parent ? { parentJurisdiction: node.parent } : {}),
        role: node.level === 1 ? 'processor' : 'sub_processor',
        level: node.level,
        ...(parentOf.get(node.id) && parentOf.get(node.id) !== 'you'
          ? { parentVendorId: parentOf.get(node.id)! }
          : {}),
        hosts: [],
        resolution: 'unresolved',
        provenance: {
          source: 'observation',
          seenAt: NOW,
          evidence: [{ evidenceId: `ev-${node.id}`, hash: HASH }],
        },
      };
      const r = VendorSchema.safeParse(vendor);
      expect(r.success, `${node.id}: ${r.error?.issues.map((i) => i.message).join('; ')}`).toBe(
        true,
      );
    }
  });

  it('the demand ledger parses', () => {
    for (const entry of fixture.demandLedger) {
      const r = DemandLedgerEntrySchema.safeParse({
        ...entry,
        sectors: entry.sectors === 'all' ? 'all' : entry.sectors.split(', '),
      });
      expect(r.success, entry.gap).toBe(true);
    }
  });
});
