import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { rankCase, rankQueue, type QueueCase, type QueueFinding } from '@gc/db';

// The commercial queue (L-03): ranked by signal × severity × how much we can solve,
// explainable row by row, and every row opens with a finding, never with how the
// product was used.

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

let n = 0;
const finding = (over: Partial<QueueFinding> = {}): QueueFinding => ({
  id: `finding:${++n}`,
  typeId: 'CNS-02',
  severity: 'serious',
  status: 'open',
  remedyKind: 'self_fix',
  ...over,
});
const kase = (over: Partial<QueueCase> = {}): QueueCase => ({
  caseId: 'DK-26-0M4K',
  company: 'Eksempelbutik ApS',
  lane: 'self-serve',
  score: 34,
  findings: [finding(), finding({ typeId: 'SEC-03', severity: 'advisory' })],
  ...over,
});

describe('one row', () => {
  it('is signal × worst open severity × the share we can solve, and says so in three lines', () => {
    const row = rankCase(
      kase({
        score: 80,
        lane: 'human',
        findings: [
          finding({ severity: 'blocking', typeId: 'REC-01' }),
          finding({ severity: 'serious', remedyKind: 'no_solution', typeId: 'TRF-01' }),
          finding({ severity: 'advisory', status: 'closed' }),
        ],
      }),
    );
    expect(row.open).toBe(2);
    expect(row.solvable).toBe(1);
    expect(row.worst).toBe('blocking');
    expect(row.rank).toBe(Math.round(80 * 3 * 0.5));
    expect(row.why).toEqual(['signal 80 (human)', '2 open, worst blocking', '1 of 2 we can solve']);
  });

  it('opens with the worst finding we can do something about, by type when tied', () => {
    const row = rankCase(
      kase({
        findings: [
          finding({
            id: 'f-gap',
            severity: 'blocking',
            remedyKind: 'no_solution',
            typeId: 'TRF-01',
          }),
          finding({ id: 'f-b', severity: 'serious', typeId: 'SEC-03', title: 'Turn on HSTS' }),
          finding({ id: 'f-a', severity: 'serious', typeId: 'CNS-02' }),
          finding({ id: 'f-c', severity: 'blocking', status: 'closed', typeId: 'AI-03' }),
        ],
      }),
    );
    expect(row.hook).toEqual({ findingId: 'f-a', typeId: 'CNS-02', title: undefined });
  });

  it('a case with nothing open has no hook and no rank', () => {
    const row = rankCase(kase({ findings: [finding({ status: 'closed' })] }));
    expect(row.rank).toBe(0);
    expect(row.hook).toBeUndefined();
    expect(row.why[1]).toBe('nothing open');
    const gapsOnly = rankCase(kase({ findings: [finding({ remedyKind: 'no_solution' })] }));
    expect(gapsOnly.rank).toBe(0);
    expect(gapsOnly.hook).toBeUndefined();
    expect(gapsOnly.why[2]).toBe('0 of 1 we can solve');
  });
});

describe('the queue', () => {
  const shop = kase();
  const logistics = kase({
    caseId: 'DE-26-1QR8',
    company: 'Nordbach Logistik GmbH',
    lane: 'human',
    score: 81,
    findings: Array.from({ length: 17 }, (_, i) =>
      finding({
        typeId: i === 0 ? 'AI-03' : 'CNS-02',
        severity: i === 0 ? 'blocking' : 'serious',
        remedyKind: i % 4 === 3 ? 'no_solution' : 'self_fix',
      }),
    ),
  });
  const clinic = kase({
    caseId: 'NL-26-04TZ',
    company: 'Zorgpunt Groep BV',
    lane: 'human',
    score: 88,
    findings: Array.from({ length: 31 }, (_, i) =>
      finding({
        typeId: i === 0 ? 'REC-01' : 'SEC-03',
        severity: i === 0 ? 'blocking' : 'advisory',
      }),
    ),
  });
  const quiet = kase({
    caseId: 'DK-26-0P52',
    company: 'Bygma Digital ApS',
    score: 41,
    findings: [],
  });

  it('ranks the highest signal, worst and most solvable first, and the empty case last', () => {
    const rows = rankQueue([shop, quiet, logistics, clinic]);
    expect(rows.map((r) => r.caseId)).toEqual([
      'NL-26-04TZ',
      'DE-26-1QR8',
      'DK-26-0M4K',
      'DK-26-0P52',
    ]);
    expect(rows[0]!.hook?.typeId).toBe('REC-01');
    expect(rows[1]!.hook?.typeId).toBe('AI-03');
    expect(rows[3]!.hook).toBeUndefined();
    for (const r of rows) expect(r.why).toHaveLength(3);
  });

  it('is stable: the same input gives the same order, ties broken by case number', () => {
    const a = kase({ caseId: 'DK-26-AAAA', score: 50 });
    const b = kase({ caseId: 'DK-26-BBBB', score: 50 });
    expect(rankQueue([b, a]).map((r) => r.caseId)).toEqual(['DK-26-AAAA', 'DK-26-BBBB']);
    expect(rankQueue([a, b])).toEqual(rankQueue([b, a]));
  });

  it('opens every call with a finding, never with usage', () => {
    const rows = rankQueue([shop, logistics, clinic, quiet]);
    for (const r of rows) {
      if (r.hook) {
        const input = [shop, logistics, clinic, quiet].find((c) => c.caseId === r.caseId)!;
        expect(input.findings.map((f) => f.id)).toContain(r.hook.findingId);
      }
      expect(JSON.stringify(r)).not.toMatch(/login|logged|visit|opened the|export|usage|session/i);
    }
    // The loader reads cases and findings and nothing about how the product was used.
    const src = readFileSync(join(ROOT, 'packages/db/src/queue.ts'), 'utf8');
    expect(src).not.toMatch(/caseEvents|case_events|accessLog|usage|analytics/);
  });
});
