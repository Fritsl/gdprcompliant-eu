import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normaliseDomain } from '@gc/db';
import {
  BrowserPool,
  FixtureServer,
  blockedRequests,
  discoverPolicies,
  loadFixtureSites,
} from '@gc/scanner';

// Server-side request forgery (T-06): a page that points the browser at the machine it
// runs on, the private network behind it, cloud metadata, a file, a private name, and a
// redirect into the network. Every one is refused before it leaves the browser, and the
// front door refuses to be pointed at such a place in the first place.

const sites = loadFixtureSites();
const identity = {
  tenantId: 't-adv',
  caseId: 'DK-26-SSRF',
  scanId: 'adv-ssrf',
  capturedAt: '2026-09-04T09:14:00Z',
};
let server: FixtureServer;
let pool: BrowserPool;

// The hosts the page tries to reach; none may be asked for, not even of the proxy.
const FORBIDDEN = [
  '127.0.0.1',
  '::1',
  '[::1]',
  '169.254.169.254',
  '10.0.0.1',
  'localhost',
  'intranet.corp',
  '192.168.1.1',
  '172.16.0.1',
];

beforeAll(async () => {
  server = await new FixtureServer(sites.flatMap((s) => s.hosts)).start();
  pool = await new BrowserPool({
    concurrency: 2,
    passTimeoutMs: 30_000,
    navigationTimeoutMs: 8_000,
    launch: { proxy: { server: server.proxy } },
    ignoreHTTPSErrors: true,
    resolveEgress: false,
  }).start();
});

afterAll(async () => {
  await pool?.stop();
  await server?.stop();
});

describe('the browser is not a proxy into anywhere', () => {
  it('every private, local, metadata and file target on the page is aborted before it leaves, and named', async () => {
    const blocked = await pool.run({ url: 'https://ssrf.shop.test/' }, async (page, context) => {
      await page.goto('https://ssrf.shop.test/', { waitUntil: 'load' });
      await page.waitForLoadState('networkidle', { timeout: 4_000 }).catch(() => undefined);
      return [...blockedRequests(context)];
    });
    const urls = blocked.map((b) => b.url);
    for (const needle of [
      'http://127.0.0.1:1/logo.png',
      'http://[::1]:1/logo2.png',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.1/',
      'http://localhost:9/style.css',
    ]) {
      expect(urls, needle).toContain(needle);
    }
    for (const b of blocked) expect(b.reason).toMatch(/private|this machine|scheme/);
    // A file: URL never becomes a network request at all; nothing served or refused names one.
    expect(
      [...server.served, ...server.refused].some((r) => 'url' in r && r.url.startsWith('file:')),
    ).toBe(false);
    // The proxy, which is the only way out here, was never asked for any of them.
    for (const host of FORBIDDEN) {
      expect(
        server.refused.map((r) => r.host),
        host,
      ).not.toContain(host);
    }
  }, 60_000);

  it('a redirect into the private network stops at the redirect', async () => {
    const outcome = await pool.run({ url: 'https://ssrf.shop.test/go' }, async (page, context) => {
      let error: string | undefined;
      try {
        await page.goto('https://ssrf.shop.test/go', { waitUntil: 'load' });
      } catch (e) {
        error = (e as Error).message;
      }
      return { error, blocked: [...blockedRequests(context)], url: page.url() };
    });
    expect(outcome.blocked.some((b) => b.url === 'http://172.16.0.1/admin')).toBe(true);
    expect(outcome.url).not.toContain('172.16.0.1');
    expect(server.refused.map((r) => r.host)).not.toContain('172.16.0.1');
  }, 60_000);

  it('policy discovery does not follow the page out of the site, whatever the link says', async () => {
    const { discovery } = await discoverPolicies(
      pool,
      { url: 'https://ssrf.shop.test/' },
      { identity, now: () => new Date(identity.capturedAt) },
    );
    for (const d of discovery.documents ?? []) {
      expect(new URL(d.url).hostname).toBe('ssrf.shop.test');
    }
    for (const host of FORBIDDEN) expect(server.refused.map((r) => r.host)).not.toContain(host);
  }, 60_000);

  it('the front door refuses to be pointed at anything but a website', () => {
    for (const input of [
      '127.0.0.1',
      '10.0.0.5',
      '169.254.169.254',
      'localhost',
      'localhost:5432',
      'metadata.google.internal',
      'intranet.corp',
      'db.internal',
      'printer.local',
      'file:///etc/passwd',
    ]) {
      expect(normaliseDomain(input), input).toBeUndefined();
    }
    expect(normaliseDomain('eksempelbutik.dk')).toBe('eksempelbutik.dk');
  });
});
