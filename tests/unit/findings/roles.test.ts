import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FINDING_AREAS, REMEDY_KINDS, TaskProposalSchema } from '@gc/contracts';
import { acceptProposal } from '@gc/agent';
import {
  DETECTORS,
  ITEM_KIND_BY_REMEDY,
  MAX_ITEMS_PER_ROLE,
  ROLES,
  ROLE_BY_AREA,
  assembleRoleLists,
  roleCoverage,
  roleFor,
  type RoleFinding,
} from '@gc/findings';

// Roles and scoped lists (P-01): scope is derived from the finding, lists are cut to
// under six by the assembler, and every item hands its question to the agent.

const REMEDIES_DIR = fileURLToPath(
  new URL('../../../packages/remedies/content/remedies/', import.meta.url),
);
const catalogueTypeIds = readdirSync(REMEDIES_DIR)
  .filter((f) => f.endsWith('.json') && !f.startsWith('catalogue'))
  .map((f) => f.split('-').slice(0, 2).join('-').toUpperCase())
  // any-00-no-solution is the fallback remedy, not a finding type.
  .filter((id) => id !== 'ANY-00');

describe('scope is derived from the finding', () => {
  it('every area and every finding type the product raises resolves to a role', () => {
    for (const area of FINDING_AREAS) expect(ROLES).toContain(ROLE_BY_AREA[area]);
    const ids = [...new Set([...DETECTORS.map((d) => d.findingTypeId), ...catalogueTypeIds])];
    expect(roleCoverage(ids)).toEqual({ unmapped: [] });
    for (const id of ids) expect(ROLES, id).toContain(roleFor({ typeId: id, area: 'Consent' }));
  });

  it('the prefix wins over the area where an area spans two desks', () => {
    expect(roleFor({ typeId: 'CNS-02', area: 'Consent' })).toBe('marketing');
    expect(roleFor({ typeId: 'FRM-01', area: 'Collection' })).toBe('marketing');
    expect(roleFor({ typeId: 'REC-01', area: 'Observation' })).toBe('it');
    expect(roleFor({ typeId: 'SEC-03', area: 'Security' })).toBe('it');
    expect(roleFor({ typeId: 'VND-06', area: 'Recipients' })).toBe('it');
    expect(roleFor({ typeId: 'TRF-01', area: 'Transfers' })).toBe('finance');
    expect(roleFor({ typeId: 'DPA-01', area: 'Contracts' })).toBe('finance');
    expect(roleFor({ typeId: 'SUB-03', area: 'Recipients' })).toBe('finance');
    expect(roleFor({ typeId: 'HR-01', area: 'Notice' })).toBe('hr');
    expect(roleFor({ typeId: 'ZZZ-99', area: 'Notice' })).toBe('marketing');
  });

  it('every remedy kind maps to something a person does', () => {
    for (const kind of REMEDY_KINDS)
      expect(['fix', 'approve', 'confirm', 'answer']).toContain(ITEM_KIND_BY_REMEDY[kind]);
  });
});

let n = 0;
const finding = (
  typeId: string,
  area: RoleFinding['area'],
  over: Partial<RoleFinding> = {},
): RoleFinding => ({
  id: `f-${++n}`,
  typeId,
  area,
  severity: 'serious',
  status: 'open',
  remedyKind: 'self_fix',
  title: `Fix ${typeId}`,
  ...over,
});

describe('the assembler', () => {
  const many: RoleFinding[] = [
    finding('CNS-01', 'Consent', { severity: 'advisory' }),
    finding('CNS-02', 'Consent', { severity: 'blocking' }),
    finding('CNS-09', 'Consent', { status: 'closed' }),
    finding('FRM-01', 'Collection'),
    finding('FRM-02', 'Collection', { severity: 'advisory' }),
    finding('FRM-03', 'Collection', { severity: 'blocking' }),
    finding('POL-01', 'Notice', {
      remedyKind: 'generated_artefact',
      title: 'Approve the privacy policy',
    }),
    finding('POL-04', 'Notice', { remedyKind: 'generated_artefact' }),
    finding('SEC-03', 'Security'),
    finding('REC-01', 'Observation', { severity: 'blocking' }),
    finding('TRF-01', 'Transfers', {
      remedyKind: 'partner_alternative',
      title: 'Choose a European alternative',
    }),
  ];

  it('cuts every role to under six items, most severe first, and counts the rest as deferred', () => {
    const lists = assembleRoleLists(many, { locale: 'en', domain: 'eksempelbutik.dk' });
    expect(lists.map((l) => l.role)).toEqual(['marketing', 'it', 'hr', 'finance']);
    const marketing = lists[0]!;
    expect(marketing.items.length).toBe(MAX_ITEMS_PER_ROLE);
    expect(marketing.items.length).toBeLessThan(6);
    expect(marketing).toMatchObject({ label: 'Marketing', open: 7, deferred: 2, done: 1 });
    expect(marketing.items.map((i) => [i.typeId, i.severity])).toEqual([
      ['CNS-02', 'blocking'],
      ['FRM-03', 'blocking'],
      ['FRM-01', 'serious'],
      ['POL-01', 'serious'],
      ['POL-04', 'serious'],
    ]);
    expect(marketing.items[3]).toMatchObject({
      kind: 'approve',
      kindLabel: 'Approve',
      text: 'Approve the privacy policy',
    });
    expect(lists[1]).toMatchObject({ role: 'it', open: 2, deferred: 0 });
    expect(lists[1]!.items.map((i) => i.typeId)).toEqual(['REC-01', 'SEC-03']);
    expect(lists[2]).toMatchObject({ role: 'hr', items: [], open: 0 });
    expect(lists[3]!.items[0]).toMatchObject({
      typeId: 'TRF-01',
      kind: 'answer',
      text: 'Choose a European alternative',
    });
    expect(() => assembleRoleLists(many, { locale: 'en', domain: 'x.dk', max: 6 })).toThrow(
      /under six/,
    );
  });

  it('every item offers "check it for me", as a proposal the catalogue accepts', () => {
    const lists = assembleRoleLists(many, { locale: 'da', domain: 'eksempelbutik.dk' });
    const items = lists.flatMap((l) => l.items);
    expect(items.length).toBeGreaterThan(5);
    for (const item of items) {
      expect(item.checkForMe.label).toBe('Det ved jeg ikke, tjek det for mig');
      expect(TaskProposalSchema.safeParse(item.checkForMe.proposal).success).toBe(true);
      const task = acceptProposal(item.checkForMe.proposal, {
        caseId: 'DK-26-0M4K',
        id: item.findingId,
        now: new Date(),
      });
      expect(task).toMatchObject({ type: 'crawl', cost: { credits: 10 } });
      expect(task.payload).toMatchObject({
        url: 'https://eksempelbutik.dk/',
        depth: 0,
        passes: ['A'],
      });
      expect(item.checkForMe.proposal.rationale).toContain(item.typeId);
    }
    expect(lists[0]!.label).toBe('Marketing');
    expect(lists[3]!.label).toBe('Økonomi / Jura');
  });
});
