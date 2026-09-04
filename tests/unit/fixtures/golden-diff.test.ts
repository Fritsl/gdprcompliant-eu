import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  diffGolden,
  formatGoldenDiff,
  goldenDiffEmpty,
  normaliseGolden,
  readGolden,
  writeGolden,
  type Golden,
} from '@gc/scanner';

// The golden differ (T-02): missing, extra and changed are named finding by finding, in
// words; the same set in any order is no difference; and a golden round-trips through
// its file in a stable order.

const golden: Golden = {
  site: 'shop.test',
  families: ['security', 'consent'],
  findings: [
    { typeId: 'SEC-03', severity: 'serious', subject: { host: 'shop.test' } },
    { typeId: 'CNS-02', severity: 'blocking', subject: { host: 'shop.test' } },
    { typeId: 'FRM-01', severity: 'serious' },
  ],
};

const dir = mkdtempSync(join(tmpdir(), 'golden-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('the golden differ', () => {
  it('the same findings in another order are no difference', () => {
    const shuffled: Golden = { ...golden, findings: [...golden.findings].reverse() };
    const diff = diffGolden(golden, shuffled);
    expect(goldenDiffEmpty(diff)).toBe(true);
    expect(diff.same).toBe(3);
    expect(formatGoldenDiff('shop', diff)).toBe('shop: golden.json matches (3 finding(s))');
  });

  it('names what is missing, what is extra and what changed, and how', () => {
    const actual: Golden = {
      ...golden,
      findings: [
        { typeId: 'SEC-03', severity: 'blocking', subject: { host: 'shop.test' } },
        { typeId: 'FRM-01', severity: 'serious' },
        { typeId: 'SEC-05', severity: 'advisory', subject: { host: 'shop.test' } },
      ],
    };
    const diff = diffGolden(golden, actual);
    expect(diff.missing.map((f) => f.typeId)).toEqual(['CNS-02']);
    expect(diff.extra.map((f) => f.typeId)).toEqual(['SEC-05']);
    expect(diff.changed.map((c) => [c.before.typeId, c.fields])).toEqual([['SEC-03', ['severity']]]);
    expect(diff.same).toBe(1);
    const text = formatGoldenDiff('shop', diff);
    expect(text).toBe(
      [
        'shop: golden.json differs (1 missing, 1 extra, 1 changed, 1 same)',
        '  missing  CNS-02 (blocking) on shop.test: in golden.json, not raised now',
        '  extra    SEC-05 (advisory) on shop.test: raised now, not in golden.json',
        '  changed  SEC-03: severity serious → blocking',
      ].join('\n'),
    );
  });

  it('a subject that moved is a change, not a missing plus an extra of the same type', () => {
    const moved: Golden = {
      ...golden,
      findings: golden.findings.map((f) =>
        f.typeId === 'FRM-01' ? { ...f, subject: { path: '/kontakt' } } : f,
      ),
    };
    const diff = diffGolden(golden, moved);
    // FRM-01 without a subject and FRM-01 at /kontakt are different identities.
    expect(diff.missing.map((f) => f.typeId)).toEqual(['FRM-01']);
    expect(diff.extra.map((f) => f.typeId)).toEqual(['FRM-01']);
    expect(formatGoldenDiff('shop', diff)).toContain('extra    FRM-01 (serious) on /kontakt');
  });

  it('round-trips through golden.json in a stable order, families sorted, empty subjects dropped', () => {
    writeGolden(dir, { ...golden, findings: [...golden.findings, { typeId: 'POL-01', severity: 'serious', subject: {} }] });
    const text = readFileSync(join(dir, 'golden.json'), 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    const back = readGolden(dir)!;
    expect(back.families).toEqual(['consent', 'security']);
    expect(back.findings.map((f) => f.typeId)).toEqual(['CNS-02', 'FRM-01', 'POL-01', 'SEC-03']);
    expect(back.findings.find((f) => f.typeId === 'POL-01')).toEqual({ typeId: 'POL-01', severity: 'serious' });
    expect(normaliseGolden(back)).toEqual(back);
    expect(readGolden(join(dir, 'nowhere'))).toBeUndefined();
  });
});
