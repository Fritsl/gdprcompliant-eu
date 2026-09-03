import dns from 'node:dns';
import net from 'node:net';
import { describe, expect, it } from 'vitest';

// The unit project has no network and no database. These tests would pass in a normal
// Node process only by luck (a closed port, a slow DNS); here they pass because the
// harness refuses before anything leaves the process.

const REFUSED = /unit tests have no network and no database/;

describe('unit tests cannot reach out (F-08)', () => {
  it('fetch is refused', async () => {
    await expect(fetch('https://eur-lex.europa.eu/')).rejects.toThrow(REFUSED);
  });

  it('a TCP connection is refused', () => {
    expect(() => net.connect({ host: '127.0.0.1', port: 5432 })).toThrow(REFUSED);
    expect(() => new net.Socket().connect(5432, '127.0.0.1')).toThrow(REFUSED);
  });

  it('name resolution is refused', async () => {
    await expect(dns.promises.lookup('eur-lex.europa.eu')).rejects.toThrow(REFUSED);
  });

  it('no database connection string is in the environment', () => {
    expect(process.env['DATABASE_URL']).toBeUndefined();
  });
});
