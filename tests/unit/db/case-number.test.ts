import { describe, expect, it } from 'vitest';
import { CASE_NUMBER_ALPHABET, CASE_NUMBER_PATTERN, CaseIdSchema } from '@gc/contracts';
import { emailAtDomain, newCaseNumber } from '@gc/db';

// Case numbers (C-01): read aloud without ambiguity, and the address rule for claiming.

describe('case numbers', () => {
  it('never contain a character that sounds or looks like another', () => {
    for (const c of '01ILOU') expect(CASE_NUMBER_ALPHABET).not.toContain(c);
    expect(CASE_NUMBER_ALPHABET).toHaveLength(30);
    expect(new Set(CASE_NUMBER_ALPHABET).size).toBe(30);
    for (let i = 0; i < 500; i += 1) {
      const id = newCaseNumber('dk', new Date('2026-09-03T00:00:00Z'));
      expect(id).toMatch(CASE_NUMBER_PATTERN);
      expect(id.startsWith('DK-26-')).toBe(true);
      expect(CaseIdSchema.safeParse(id).success).toBe(true);
    }
  });

  it('is deterministic given the random source, and refuses a bad country', () => {
    expect(newCaseNumber('DE', new Date('2031-01-01T00:00:00Z'), () => 0)).toBe('DE-31-2222');
    expect(newCaseNumber('DE', new Date('2031-01-01T00:00:00Z'), (max) => max - 1)).toBe(
      'DE-31-ZZZZ',
    );
    expect(() => newCaseNumber('Danmark', new Date())).toThrow(/not a country code/);
  });
});

describe('an address at the scanned domain', () => {
  it('is the domain or a host under it, case-insensitively, and nothing that merely contains it', () => {
    expect(emailAtDomain('mette@eksempelbutik.dk', 'eksempelbutik.dk')).toBe(true);
    expect(emailAtDomain('Mette@Mail.Eksempelbutik.dk', 'www.eksempelbutik.dk')).toBe(true);
    expect(emailAtDomain('mette@gmail.com', 'eksempelbutik.dk')).toBe(false);
    expect(emailAtDomain('mette@eksempelbutik.dk.evil.test', 'eksempelbutik.dk')).toBe(false);
    expect(emailAtDomain('mette@notEksempelbutik.dk', 'eksempelbutik.dk')).toBe(false);
    expect(emailAtDomain('not an address', 'eksempelbutik.dk')).toBe(false);
    expect(emailAtDomain('two@@eksempelbutik.dk', 'eksempelbutik.dk')).toBe(false);
  });
});
