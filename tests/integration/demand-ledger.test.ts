import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256 } from '@gc/contracts';
import {
  PostgresDemandLedger,
  createTestDatabase,
  demandCsv,
  purgeDemandEntries,
  rankedDemand,
  schema,
  testDatabaseUrl,
  withTenant,
  withoutTenant,
  type TestDatabase,
} from '@gc/db';
import { loadCatalogue, resolveAndRecord } from '@gc/remedies';

// The demand ledger (R-05): the write path runs from the resolver, as the tenant, on the
// first no_solution; a tenant sees only its own rows; the ranked view drops any group
// smaller than k tenants and never carries an identifier; CSV and page read the same.

const url = (() => {
  try {
    return testDatabaseUrl();
  } catch (e) {
    if (process.env['CI']) throw e;
    console.warn((e as Error).message);
    return undefined;
  }
})();

const catalogue = loadCatalogue();
const T0 = new Date('2026-09-03T09:14:00Z');

// Five tenants: three Danish retailers hit XYZ-99, one Danish clinic hits XYZ-99, one
// German retailer hits ABC-77. Only the retailers' XYZ-99 group has three tenants.
const TENANTS = [
  {
    id: 'tenant-1',
    caseId: 'DK-26-AAA1',
    country: 'DK',
    sector: 'retail',
    band: '10-49',
    type: 'XYZ-99',
    j: 'DK',
  },
  {
    id: 'tenant-2',
    caseId: 'DK-26-AAA2',
    country: 'DK',
    sector: 'retail',
    band: '10-49',
    type: 'XYZ-99',
    j: 'DK',
  },
  {
    id: 'tenant-3',
    caseId: 'DK-26-AAA3',
    country: 'DK',
    sector: 'retail',
    band: '50-249',
    type: 'XYZ-99',
    j: 'DK',
  },
  {
    id: 'tenant-4',
    caseId: 'DK-26-AAA4',
    country: 'DK',
    sector: 'health',
    band: '10-49',
    type: 'XYZ-99',
    j: 'DK',
  },
  {
    id: 'tenant-5',
    caseId: 'DE-26-AAA5',
    country: 'DE',
    sector: 'retail',
    band: '10-49',
    type: 'ABC-77',
    j: 'DE',
  },
] as const;

describe.skipIf(!url)('the demand ledger (R-05)', () => {
  let t: TestDatabase;

  beforeAll(async () => {
    t = await createTestDatabase(url);
    for (const x of TENANTS) {
      await t.db
        .insert(schema.tenants)
        .values({ id: x.id, name: x.id, tenantId: x.id, sourceRef: 'test' });
      await t.db.insert(schema.cases).values({
        id: x.caseId,
        tenantId: x.id,
        sourceRef: 'test',
        company: {
          domain: `${x.id}.dk`,
          country: x.country,
          locale: 'da',
          sector: x.sector,
          headcountBand: x.band,
        },
        jurisdiction: x.j,
        locale: 'da',
        openedAt: T0,
        lane: 'self-serve',
      });
    }
  });

  afterAll(async () => {
    await t?.drop();
  });

  it('the write path runs from the resolver, as the tenant, and a real remedy writes nothing', async () => {
    for (const [i, x] of TENANTS.entries()) {
      await withTenant(t, x.id, async (tx) => {
        const ledger = new PostgresDemandLedger(
          tx,
          x.id,
          { country: x.country, sector: x.sector, headcountBand: x.band },
          () => new Date(T0.getTime() + i * 86_400_000),
        );
        const gap = await resolveAndRecord(
          catalogue,
          x.type,
          { jurisdiction: x.j, locale: 'en', values: { domain: `${x.id}.dk` } },
          ledger,
          {
            caseId: x.caseId,
            sector: x.sector,
            now: () => new Date(T0.getTime() + i * 86_400_000),
          },
        );
        expect(gap.remedy.kind).toBe('no_solution');
        const fine = await resolveAndRecord(
          catalogue,
          'SEC-03',
          { jurisdiction: x.j, locale: 'en', values: { domain: `${x.id}.dk` } },
          ledger,
          { caseId: x.caseId },
        );
        expect(fine.remedy.kind).toBe('self_fix');
      });
    }
    const all = await t.db.select().from(schema.demandEntries);
    expect(all.length).toBe(TENANTS.length);
    expect(all.find((r) => r.tenantId === 'tenant-4')).toMatchObject({
      caseId: 'DK-26-AAA4',
      findingTypeId: 'XYZ-99',
      jurisdiction: 'DK',
      answer: 'none',
      sector: 'health',
      headcountBand: '10-49',
      country: 'DK',
      cause: 'any-00-no-solution: no remedy in the catalogue for XYZ-99 in DK',
    });
  });

  it('a tenant reads only its own rows, and no context reads none', async () => {
    const mine = await withTenant(t, 'tenant-2', (tx) => tx.select().from(schema.demandEntries));
    expect(mine.map((r) => r.tenantId)).toEqual(['tenant-2']);
    const none = await withoutTenant(t, (tx) => tx.select().from(schema.demandEntries));
    expect(none).toEqual([]);
  });

  it('the ranked view keeps only groups of at least k tenants, and carries no identifier', async () => {
    const rows = await rankedDemand(t, { k: 3 });
    expect(rows).toEqual([
      {
        findingTypeId: 'XYZ-99',
        jurisdiction: 'DK',
        country: null,
        sector: null,
        headcountBand: null,
        tenants: 4,
        cases: 4,
        entries: 4,
        firstSeenAt: '2026-09-03T09:14:00.000Z',
        lastSeenAt: '2026-09-06T09:14:00.000Z',
      },
      {
        findingTypeId: 'XYZ-99',
        jurisdiction: 'DK',
        country: 'DK',
        sector: 'retail',
        headcountBand: null,
        tenants: 3,
        cases: 3,
        entries: 3,
        firstSeenAt: '2026-09-03T09:14:00.000Z',
        lastSeenAt: '2026-09-05T09:14:00.000Z',
      },
    ]);
    // The lone clinic and the lone German retailer never surface, at any grain.
    const text = JSON.stringify(rows);
    for (const never of [
      'health',
      'DE',
      'ABC-77',
      'tenant-',
      'DK-26-',
      '50-249',
      'tenant_id',
      'case_id',
    ]) {
      expect(text, never).not.toContain(never);
    }
    // Same answer as the app role, which is what the page and the CSV route use.
    const asApp = await withoutTenant(t, (tx) =>
      tx.execute('select count(*)::int as n from demand_ranked(3)'),
    );
    expect(Number(asApp.at(0)?.['n'])).toBe(2);
    // A lower threshold is refused; two is the floor.
    await expect(rankedDemand(t, { k: 1 })).rejects.toThrow(/at least 2/);
    expect((await rankedDemand(t, { k: 2 })).length).toBeGreaterThan(2);
  });

  it('the CSV is the ranked view, header first, nothing else', async () => {
    const csv = demandCsv(await rankedDemand(t, { k: 3 }));
    expect(csv.split('\r\n')).toEqual([
      'findingTypeId,jurisdiction,country,sector,headcountBand,tenants,cases,entries,firstSeenAt,lastSeenAt',
      'XYZ-99,DK,,,,4,4,4,2026-09-03T09:14:00.000Z,2026-09-06T09:14:00.000Z',
      'XYZ-99,DK,DK,retail,,3,3,3,2026-09-03T09:14:00.000Z,2026-09-05T09:14:00.000Z',
      '',
    ]);
  });

  it('retention: rows older than the cut-off are purged, the rest stay', async () => {
    expect(await purgeDemandEntries(t.db, new Date('2026-09-05T00:00:00Z'))).toBe(2);
    expect((await t.db.select().from(schema.demandEntries)).length).toBe(3);
    expect(await purgeDemandEntries(t.db, new Date('2020-01-01T00:00:00Z'))).toBe(0);
  });
});

describe('the ledger writes nothing a person could be found by', () => {
  it('the row shape has no name, address, domain or contact field', () => {
    const columns = Object.keys(schema.demandEntries);
    for (const c of columns) expect(c, c).not.toMatch(/name|address|domain|email|phone|owner/i);
    expect(sha256('r')).toHaveLength(64);
  });
});
