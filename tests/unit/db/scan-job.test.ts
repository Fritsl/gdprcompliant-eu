import { describe, expect, it } from 'vitest';
import {
  RateLimiter,
  SCAN_JOB,
  SCAN_QUEUE_DEPTH_CAP,
  SCAN_STAGES,
  SCANS_PER_SOURCE_PER_HOUR,
  ScanProgressSchema,
  normaliseDomain,
} from '@gc/db';

// The front door's small parts (U-02): a domain however it was typed, a rate limit per
// source, and the scan job's shape.

describe('normaliseDomain', () => {
  it('takes a domain however it was typed, and gives back the host', () => {
    for (const [input, host] of [
      ['eksempelbutik.dk', 'eksempelbutik.dk'],
      ['  Eksempelbutik.DK  ', 'eksempelbutik.dk'],
      ['https://www.eksempelbutik.dk/shop?x=1', 'www.eksempelbutik.dk'],
      ['http://eksempelbutik.dk.', 'eksempelbutik.dk'],
      ['eksempelbutik.dk/kontakt', 'eksempelbutik.dk'],
      ['shop.eksempel-butik.co.uk', 'shop.eksempel-butik.co.uk'],
    ]) {
      expect(normaliseDomain(input!), input).toBe(host);
    }
  });

  it('refuses what is not a website address', () => {
    for (const input of [
      '',
      'hello',
      'a b.dk',
      'localhost',
      '127.0.0.1',
      'not a domain',
      '-bad.dk',
      'x'.repeat(300),
    ]) {
      expect(normaliseDomain(input), input).toBeUndefined();
    }
  });
});

describe('the rate limit per source', () => {
  it('allows the limit within the window, refuses the next, and says when to try again', () => {
    const limiter = new RateLimiter(2, 60_000);
    const t0 = 1_000_000;
    expect(limiter.allow('a', t0)).toBe(true);
    expect(limiter.allow('a', t0 + 1_000)).toBe(true);
    expect(limiter.allow('a', t0 + 2_000)).toBe(false);
    expect(limiter.retryAfter('a', t0 + 2_000)).toBe(58);
    expect(limiter.allow('b', t0 + 2_000)).toBe(true);
    expect(limiter.allow('a', t0 + 61_000)).toBe(true);
    expect(limiter.retryAfter('a', t0 + 61_000)).toBe(0);
  });

  it('has sane defaults', () => {
    expect(SCANS_PER_SOURCE_PER_HOUR).toBe(5);
    expect(SCAN_QUEUE_DEPTH_CAP).toBe(50);
  });
});

describe('the scan job', () => {
  it('names ten stages in the order the visitor watches them, and carries a case token at the end', () => {
    expect(SCAN_JOB.name).toBe('scan-site');
    expect(SCAN_STAGES).toHaveLength(10);
    expect(SCAN_STAGES[0]).toBe('opening');
    expect(SCAN_STAGES.at(-1)).toBe('writing-up');
    expect(
      SCAN_JOB.payload.safeParse({ domain: 'shop.dk', locale: 'da', source: 'front-door' }).success,
    ).toBe(true);
    expect(
      SCAN_JOB.payload.safeParse({ domain: '', locale: 'da', source: 'front-door' }).success,
    ).toBe(false);
    const done = ScanProgressSchema.safeParse({
      stages: [{ stage: 'opening', mark: 'ok', at: '2026-09-04T09:14:00Z' }],
      outcome: 'case',
      caseToken: 'abc',
      findings: 3,
    });
    expect(done.success).toBe(true);
    expect(
      ScanProgressSchema.safeParse({ stages: [{ stage: 'nope', mark: 'ok', at: 'x' }] }).success,
    ).toBe(false);
  });
});
