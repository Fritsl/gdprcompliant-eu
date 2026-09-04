import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FindingSchema, SUPPORTED_JURISDICTIONS } from '@gc/contracts';
import { DETECTORS, checkFindingCompleteness, expectedByFixtures } from '@gc/findings';
import {
  Catalogue,
  MemoryDemandLedger,
  loadCatalogue,
  resolveAndRecord,
  type ResolveContext,
} from '@gc/remedies';

const catalogue = loadCatalogue();
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

describe('no finding without a remedy is structural (R-02)', () => {
  it('the Finding type cannot be constructed without a remedy reference', () => {
    const base = {
      id: 'f',
      tenantId: 't',
      caseId: 'DK-26-0M4K',
      typeId: 'CNS-02',
      fingerprint: 'x',
      jurisdiction: 'DK',
      binding: {
        findingTypeId: 'CNS-02',
        jurisdiction: 'DK',
        citations: [{ kind: 'provision', instrument: 'ePrivacy', article: '5', ref: 'Art. 5(3)' }],
        authority: { name: 'x' },
        guideId: 'x',
        version: 1,
      },
      severity: 'blocking',
      status: 'open',
      area: 'Consent',
      evidence: [{ evidenceId: 'e', hash: 'a'.repeat(64) }],
      firstSeenAt: '2026-09-03T00:00:00Z',
      lastSeenAt: '2026-09-03T00:00:00Z',
    };
    expect(FindingSchema.safeParse(base).success).toBe(false);
    expect(
      FindingSchema.safeParse({ ...base, remedy: { remedyId: 'cns-02-gate-tags', version: 1 } })
        .success,
    ).toBe(true);
  });

  it('the database refuses it: NOT NULL columns and a foreign key in the committed migration', () => {
    const sql = readFileSync(
      join(ROOT, 'packages', 'db', 'migrations', '0001_talented_phantom_reporter.sql'),
      'utf8',
    );
    expect(sql).toMatch(/"remedy_id" text NOT NULL/);
    expect(sql).toMatch(/"remedy_version" integer NOT NULL/);
    expect(sql).toMatch(
      /CONSTRAINT "findings_remedy_fk" FOREIGN KEY \("remedy_id","remedy_version"\) REFERENCES "remedies"/,
    );
  });

  it('every registered detector and every fixture promise has a remedy in every supported jurisdiction', () => {
    expect(DETECTORS.length).toBeGreaterThanOrEqual(8);
    const promised = expectedByFixtures();
    expect([...promised.keys()]).toEqual(expect.arrayContaining(['CNS-01', 'CNS-02', 'SEC-01']));
    const result = checkFindingCompleteness(catalogue);
    expect(result.jurisdictions).toEqual([...SUPPORTED_JURISDICTIONS]);
    expect(result.findingTypes).toEqual(
      expect.arrayContaining([...DETECTORS.map((d) => d.findingTypeId), ...promised.keys()]),
    );
    expect(result.gaps).toEqual([]);
  });

  it('a detector without a remedy in one jurisdiction is a gap that names who promised it', () => {
    const dkOnly = {
      ...structuredClone(catalogue.get('sec-03-hsts')!.remedy),
      id: 'sec-03-dk',
      jurisdictions: ['DK'],
    };
    const small = new Catalogue([{ remedy: dkOnly, file: 'sec-03-dk.json', hash: 'x' }]);
    const empty = mkdtempSync(join(tmpdir(), 'no-fixtures-'));
    const result = checkFindingCompleteness(small, {
      detectors: [
        {
          findingTypeId: 'SEC-03',
          area: 'Security',
          detector: 'scanner/checks/security#hsts',
          defaultSeverity: 'serious',
        },
      ],
      fixturesDir: empty,
    });
    expect(result.gaps).toEqual([
      { findingTypeId: 'SEC-03', jurisdiction: 'DE', promisedBy: ['scanner/checks/security#hsts'] },
    ]);
  });

  it('a fixture that expects a finding promises it too', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fixtures-'));
    mkdirSync(join(dir, 'weird'));
    writeFileSync(
      join(dir, 'weird', 'expected.json'),
      JSON.stringify({ site: 'x.test', description: 'x', findings: { must: ['ZZZ-99'] } }),
    );
    const result = checkFindingCompleteness(catalogue, { detectors: [], fixturesDir: dir });
    expect(result.gaps.map((g) => `${g.findingTypeId}/${g.jurisdiction}`)).toEqual([
      'ZZZ-99/DK',
      'ZZZ-99/DE',
    ]);
    expect(result.gaps[0]?.promisedBy).toEqual(['fixture:weird']);
  });
});

describe('a no_solution satisfies the constraint and writes to the demand ledger (R-02)', () => {
  const context: ResolveContext = { jurisdiction: 'DK', locale: 'en', values: { domain: 'x.dk' } };

  it('records the gap, the case and the cause, and still returns a remedy', async () => {
    const ledger = new MemoryDemandLedger();
    const resolution = await resolveAndRecord(catalogue, 'XYZ-99', context, ledger, {
      caseId: 'DK-26-0M4K',
      sector: 'retail',
      now: () => new Date('2026-09-03T12:00:00Z'),
    });
    expect(resolution.remedy.kind).toBe('no_solution');
    expect(resolution.ref.remedyId).toBe('any-00-no-solution');
    expect(ledger.entries).toEqual([
      {
        gap: 'No remedy in the catalogue closes the finding for this setup',
        seen: 1,
        sectors: ['retail'],
        answer: 'none',
        firstSeenAt: '2026-09-03T12:00:00.000Z',
        lastSeenAt: '2026-09-03T12:00:00.000Z',
        findingTypeId: 'XYZ-99',
        jurisdiction: 'DK',
        caseId: 'DK-26-0M4K',
        sector: 'retail',
        cause: 'any-00-no-solution: no remedy in the catalogue for XYZ-99 in DK',
      },
    ]);
  });

  it('writes nothing when a real remedy closes the finding', async () => {
    const ledger = new MemoryDemandLedger();
    const resolution = await resolveAndRecord(catalogue, 'SEC-03', context, ledger, {
      caseId: 'DK-26-0M4K',
    });
    expect(resolution.remedy.kind).toBe('self_fix');
    expect(ledger.entries).toEqual([]);
  });
});

describe('the promise list reads only what is there (R-02)', () => {
  it('a missing estate, a site without expected.json and a malformed id all count for nothing', () => {
    expect(expectedByFixtures(join(tmpdir(), 'does-not-exist-' + Date.now())).size).toBe(0);
    const dir = mkdtempSync(join(tmpdir(), 'fixtures-'));
    mkdirSync(join(dir, 'no-expectation'));
    mkdirSync(join(dir, 'odd'));
    writeFileSync(
      join(dir, 'odd', 'expected.json'),
      JSON.stringify({
        site: 'x.test',
        description: 'x',
        findings: { must: ['Art. 5(3)', 'CNS-02'] },
      }),
    );
    expect([...expectedByFixtures(dir).entries()]).toEqual([['CNS-02', ['odd']]]);
    const only = checkFindingCompleteness(catalogue, {
      detectors: [],
      fixturesDir: dir,
      jurisdictions: ['FR'],
    });
    expect(only.findingTypes).toEqual(['CNS-02']);
    expect(only.gaps).toEqual([]);
  });
});
