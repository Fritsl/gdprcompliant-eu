import { describe, expect, it } from 'vitest';
import { CitationSchema, citationKey, parseProvisionRef } from '@gc/contracts';

describe('Citation', () => {
  it('parses a display reference into a mechanical key', () => {
    const c = parseProvisionRef('GDPR', 'Art. 13(2)(a)', { note: 'storage period must be stated' });
    expect(c).toMatchObject({
      kind: 'provision',
      instrument: 'GDPR',
      article: '13',
      paragraph: '2',
      point: 'a',
    });
    expect(citationKey(c!)).toBe('GDPR:13:2:a');
    expect(citationKey(parseProvisionRef('GDPR', 'Art. 28')!)).toBe('GDPR:28');
    expect(citationKey(parseProvisionRef('ePrivacy', 'Article 5(3)')!)).toBe('ePrivacy:5:3');
  });

  it('a range resolves to its first article and keeps the display form', () => {
    const c = parseProvisionRef('GDPR', 'Art. 44–49');
    expect(c?.article).toBe('44');
    expect(c?.ref).toBe('Art. 44–49');
  });

  it('refuses what it cannot resolve', () => {
    expect(parseProvisionRef('GDPR', 'somewhere in chapter V')).toBeUndefined();
    expect(parseProvisionRef('Case law', 'Art. 5')).toBeUndefined();
  });

  it('decisions and guidance are citations too, with their own keys', () => {
    const decision = CitationSchema.parse({
      kind: 'decision',
      body: 'LG München I',
      reference: '3 O 17493/20',
      ref: 'LG München I, 3 O 17493/20',
      jurisdiction: 'DE',
    });
    expect(citationKey(decision)).toBe('LG München I:3 O 17493/20');

    const guidance = CitationSchema.parse({
      kind: 'guidance',
      authority: 'Datatilsynet',
      title: 'Vejledning om cookies',
      section: '4.2',
      ref: 'Datatilsynet, cookie guidance §4.2',
      jurisdiction: 'DK',
    });
    expect(citationKey(guidance)).toBe('Datatilsynet:Vejledning om cookies:4.2');
  });

  it('a citation is never free text', () => {
    expect(
      CitationSchema.safeParse({ kind: 'provision', instrument: 'GDPR', ref: 'Art. 5' }).success,
    ).toBe(false);
    expect(CitationSchema.safeParse('GDPR Art. 5').success).toBe(false);
  });
});
