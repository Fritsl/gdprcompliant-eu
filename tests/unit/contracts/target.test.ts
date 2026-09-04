import { describe, expect, it } from 'vitest';
import { describeUnresolved, inferTarget } from '@gc/contracts';

// Where a target is (I-03): the site's own language first, then its top-level domain,
// then the register; a target none of them place in a supported jurisdiction is said
// so, never guessed.

describe('inferring the target', () => {
  it('reads the site language first, whatever the domain', () => {
    expect(inferTarget({ domain: 'shop.dk', documentLang: 'de' })).toMatchObject({
      ok: true,
      jurisdiction: 'DE',
      locale: 'de',
      basis: 'language',
      signal: 'de',
    });
    expect(inferTarget({ domain: 'example.com', documentLang: 'da-DK' })).toMatchObject({
      jurisdiction: 'DK',
      locale: 'da',
      basis: 'language',
    });
    expect(inferTarget({ domain: 'example.com', contentLanguage: 'de-DE' })).toMatchObject({
      jurisdiction: 'DE',
      basis: 'language',
      signal: 'de-DE',
    });
  });

  it('falls to the top-level domain when the language does not place it', () => {
    expect(inferTarget({ domain: 'shop.dk', documentLang: 'en' })).toMatchObject({
      jurisdiction: 'DK',
      locale: 'da',
      basis: 'tld',
      signal: '.dk',
    });
    // German spoken in a region the product does not cover: the tag is not a placement.
    expect(inferTarget({ domain: 'shop.de', documentLang: 'de-CH' })).toMatchObject({
      jurisdiction: 'DE',
      basis: 'tld',
    });
  });

  it('falls to the register last', () => {
    expect(
      inferTarget({ domain: 'shop.test', documentLang: 'en', registryCountry: 'DE' }),
    ).toMatchObject({
      jurisdiction: 'DE',
      basis: 'registry',
      signal: 'DE',
    });
  });

  it('a target in no supported jurisdiction is unresolved, with what was tried', () => {
    const r = inferTarget({ domain: 'boutique.fr', documentLang: 'fr', registryCountry: 'FR' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('unsupported_target');
    expect(r.tried).toEqual([
      { basis: 'language', signal: 'fr', outcome: 'not a supported jurisdiction' },
      { basis: 'tld', signal: '.fr', outcome: 'no country' },
      { basis: 'registry', signal: 'FR', outcome: 'not supported' },
    ]);
    expect(describeUnresolved(r)).toBe(
      'language fr: not a supported jurisdiction; tld .fr: no country; registry FR: not supported — the product speaks DK, DE',
    );
    const bare = inferTarget({ domain: 'example.com' });
    expect(!bare.ok && describeUnresolved(bare)).toBe(
      'tld .com: no country — the product speaks DK, DE',
    );
  });
});
