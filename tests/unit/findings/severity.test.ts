import { describe, expect, it } from 'vitest';
import { SEVERITY_TABLE, severityFor } from '@gc/findings';

// The severity table (S-14): base plus rules, in order, each named in the decision.

describe('the severity table', () => {
  it('names four rules with a description each', () => {
    expect(SEVERITY_TABLE.rules.map((r) => r.id)).toEqual([
      'observed',
      'many-hosts',
      'sensitive-sector',
      'regressed',
    ]);
    for (const r of SEVERITY_TABLE.rules) expect(r.description.length).toBeGreaterThan(20);
  });

  it('takes the base when nothing applies', () => {
    expect(severityFor('advisory', { area: 'Security' })).toEqual({
      severity: 'advisory',
      base: 'advisory',
      applied: [],
    });
  });

  it('takes the higher of base and what the detector observed', () => {
    expect(severityFor('advisory', { area: 'Collection', observed: 'serious' })).toMatchObject({
      severity: 'serious',
      applied: ['observed'],
    });
    expect(severityFor('blocking', { area: 'Collection', observed: 'advisory' })).toMatchObject({
      severity: 'blocking',
      applied: [],
    });
  });

  it('raises a consent finding that names three or more hosts, and stops at blocking', () => {
    expect(severityFor('serious', { area: 'Consent', hosts: 2 }).severity).toBe('serious');
    expect(severityFor('serious', { area: 'Consent', hosts: 3 })).toMatchObject({
      severity: 'blocking',
      applied: ['many-hosts'],
    });
    expect(severityFor('blocking', { area: 'Consent', hosts: 9 }).severity).toBe('blocking');
    expect(severityFor('serious', { area: 'Security', hosts: 9 }).applied).toEqual([]);
  });

  it('raises collection and consent findings in health and education, by NACE code', () => {
    expect(severityFor('advisory', { area: 'Collection', sectorCode: '86.21.00' })).toMatchObject({
      severity: 'serious',
      applied: ['sensitive-sector'],
    });
    expect(severityFor('advisory', { area: 'Collection', sectorCode: '47.91' }).applied).toEqual(
      [],
    );
    expect(severityFor('advisory', { area: 'Security', sectorCode: '86.21' }).applied).toEqual([]);
  });

  it('raises a finding that came back after being closed, and rules stack in order', () => {
    expect(severityFor('advisory', { area: 'Consent', previousStatus: 'closed' })).toMatchObject({
      severity: 'serious',
      applied: ['regressed'],
    });
    expect(
      severityFor('advisory', {
        area: 'Consent',
        hosts: 3,
        sectorCode: '85.10',
        previousStatus: 'closed',
      }),
    ).toEqual({
      severity: 'blocking',
      base: 'advisory',
      applied: ['many-hosts', 'sensitive-sector'],
    });
  });
});
