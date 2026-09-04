import { describe, expect, it } from 'vitest';
import { forbiddenTarget, privateAddress } from '@gc/scanner';

// Where the browser may not go (T-06): the machine it runs on, the private network
// behind it, cloud metadata, anything that is not the web.

describe('forbidden targets', () => {
  it('refuses every private range, loopback, link-local and the metadata addresses', () => {
    for (const ip of [
      '127.0.0.1',
      '127.9.9.9',
      '10.0.0.1',
      '10.255.255.255',
      '172.16.0.1',
      '172.31.255.254',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '::1',
      '::',
      'fc00::1',
      'fd12::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.5',
    ]) {
      expect(privateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '185.60.216.35', '2a00:1450:4001:82a::200e']) {
      expect(privateAddress(ip), ip).toBe(false);
    }
  });

  it('names the reason: scheme, private name, private address, or a bare address', () => {
    expect(forbiddenTarget('file:///etc/passwd')).toMatch(/scheme file:/);
    expect(forbiddenTarget('ftp://example.dk/x')).toMatch(/scheme ftp:/);
    expect(forbiddenTarget('javascript:alert(1)')).toMatch(/scheme/);
    expect(forbiddenTarget('http://localhost:8080/policy')).toMatch(/this machine/);
    expect(forbiddenTarget('http://metadata.google.internal/computeMetadata/v1/')).toMatch(
      /this machine/,
    );
    expect(forbiddenTarget('http://intranet.corp/')).toMatch(/private name/);
    expect(forbiddenTarget('http://printer.local/')).toMatch(/private name/);
    expect(forbiddenTarget('http://db.internal:5432/')).toMatch(/private name/);
    expect(forbiddenTarget('http://127.0.0.1:5432/')).toMatch(/private address/);
    expect(forbiddenTarget('http://169.254.169.254/latest/meta-data/')).toMatch(/private address/);
    expect(forbiddenTarget('http://[::1]/')).toMatch(/private address/);
    expect(forbiddenTarget('http://[fe80::1]/')).toMatch(/private address/);
    // A public address is not a website either: the scanner reads sites by name.
    expect(forbiddenTarget('http://8.8.8.8/')).toMatch(/an address, not a site/);
    expect(forbiddenTarget('not a url')).toBe('not a URL');
  });

  it('lets the web through', () => {
    for (const url of [
      'https://eksempelbutik.dk/',
      'http://usikker.test/kontakt',
      'https://analytics.tracker.test/tag.js',
      'https://www.example.co.uk/a?b=c',
    ]) {
      expect(forbiddenTarget(url), url).toBeUndefined();
    }
  });
});
