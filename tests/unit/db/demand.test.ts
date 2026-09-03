import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEMAND_RETENTION_MONTHS,
  RankedDemandRowSchema,
  demandCsv,
  demandRetentionCutoff,
} from '@gc/db';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

// The ledger's pure parts (R-05): the CSV, the retention arithmetic, and the row shape
// that cannot carry an identifier.

const row = RankedDemandRowSchema.parse({
  findingTypeId: 'XYZ-99',
  jurisdiction: 'DK',
  country: 'DK',
  sector: 'retail, "food"',
  headcountBand: null,
  tenants: 3,
  cases: 4,
  entries: 5,
  firstSeenAt: '2026-01-01T00:00:00.000Z',
  lastSeenAt: '2026-09-01T00:00:00.000Z',
});

describe('demand CSV', () => {
  it('quotes what needs quoting, leaves nulls empty, ends every line with CRLF', () => {
    expect(demandCsv([row])).toBe(
      'findingTypeId,jurisdiction,country,sector,headcountBand,tenants,cases,entries,firstSeenAt,lastSeenAt\r\n' +
        'XYZ-99,DK,DK,"retail, ""food""",,3,4,5,2026-01-01T00:00:00.000Z,2026-09-01T00:00:00.000Z\r\n',
    );
    expect(demandCsv([])).toBe(
      'findingTypeId,jurisdiction,country,sector,headcountBand,tenants,cases,entries,firstSeenAt,lastSeenAt\r\n',
    );
  });

  it('the row shape refuses an identifier and a zero group', () => {
    expect(RankedDemandRowSchema.safeParse({ ...row, tenantId: 't' }).success).toBe(true);
    expect(Object.keys(RankedDemandRowSchema.parse({ ...row, tenantId: 't' }))).not.toContain(
      'tenantId',
    );
    expect(RankedDemandRowSchema.safeParse({ ...row, tenants: 0 }).success).toBe(false);
  });
});

describe('retention', () => {
  it('is twenty-four months, as the decision says', () => {
    expect(DEMAND_RETENTION_MONTHS).toBe(24);
    expect(demandRetentionCutoff(new Date('2026-09-03T12:00:00Z')).toISOString()).toBe(
      '2024-09-03T12:00:00.000Z',
    );
    const decision = readFileSync(join(ROOT, 'docs', 'decisions', 'demand-ledger.md'), 'utf8');
    expect(decision).toMatch(/\*\*24 months\*\*/);
    expect(decision).toMatch(/at least `k` distinct tenants \(default 3\)/);
  });
});
