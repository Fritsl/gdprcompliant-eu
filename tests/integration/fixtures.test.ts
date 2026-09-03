import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BrowserPool,
  FixtureServer,
  collectPassA,
  loadFixtureSites,
  type FixtureSite,
} from '@gc/scanner';

// The fixture estate, end to end: every host served by the fixture server, a real
// Chromium sent through it as its proxy, and each fixture's first-load expectation
// checked against what Pass A actually captured. Nothing reaches the internet: a
// stranger gets a 502, TLS gets refused.

const sites = loadFixtureSites();
let server: FixtureServer;
let browser: Browser;
let pool: BrowserPool;

beforeAll(async () => {
  server = await new FixtureServer(sites.flatMap((s) => s.hosts)).start();
  browser = await chromium.launch({ proxy: { server: server.proxy } });
  pool = await new BrowserPool({
    concurrency: 2,
    passTimeoutMs: 30_000,
    navigationTimeoutMs: 10_000,
    launch: { proxy: { server: server.proxy } },
    ignoreHTTPSErrors: true,
  }).start();
});

afterAll(async () => {
  await pool?.stop();
  await browser?.close();
  await server?.stop();
});

async function firstLoad(site: FixtureSite) {
  const { capture } = await collectPassA(pool, { url: `http://${site.expected.site}/` });
  expect(capture.status, site.name).toBe(200);
  return {
    capture,
    hosts: new Set(capture.requests.map((r) => r.host)),
    failed: capture.requests.filter((r) => r.failed).map((r) => `${r.url} ${r.failed}`),
  };
}

describe('fixture sites through the proxy (F-07)', () => {
  it('serves every fixture host and refuses everything else', () => {
    expect(server.certificate).toMatch(/BEGIN CERTIFICATE/);
    expect(server.hostNames()).toEqual(
      expect.arrayContaining(['eksempelbutik.test', 'analytics.tracker.test', 'brochure.test']),
    );
  });

  for (const site of sites) {
    it(`${site.name}: the first load contacts exactly what expected.json says`, async () => {
      const { hosts, failed } = await firstLoad(site);
      const { mustContact, mustNotContact } = site.expected.network.firstLoad;
      for (const h of mustContact) expect(hosts, `${site.name} never contacted ${h}`).toContain(h);
      for (const h of mustNotContact) expect(hosts, `${site.name} contacted ${h}`).not.toContain(h);
      // Every request the page made went to a fixture host, and none of them failed.
      const own = new Set(site.hosts.map((h) => h.host));
      for (const h of hosts) expect(own.has(h), `${site.name} reached ${h}`).toBe(true);
      expect(failed).toEqual([]);
    });
  }

  it('the reference fixture actually has the bug: the tag fires before any consent', async () => {
    const site = sites.find((s) => s.name === 'reject-not-honoured')!;
    let bannerVisible = false;
    const { capture, hosts } = await collectPassA(
      pool,
      { url: `http://${site.expected.site}/` },
      { inspect: async (page) => void (bannerVisible = await page.locator('#cmp').isVisible()) },
    ).then((r) => ({ capture: r.capture, hosts: new Set(r.capture.requests.map((q) => q.host)) }));
    expect(hosts).toContain('analytics.tracker.test');
    expect(bannerVisible).toBe(true);
    expect(capture.cookies.map((c) => c.name)).toContain('_trk');
    expect(
      server.served.some(
        (s) => s.host === 'analytics.tracker.test' && s.path === '/collect' && s.status === 204,
      ),
    ).toBe(true);
  });

  it('the clean control loads nothing from anyone and stores nothing', async () => {
    const site = sites.find((s) => s.name === 'clean-brochure')!;
    const { capture, hosts } = await firstLoad(site);
    expect([...hosts]).toEqual(['brochure.test']);
    expect(capture.cookies).toEqual([]);
    expect(capture.storage).toEqual([]);
  });

  it('a host outside the fixture is refused with a 502, and TLS is refused outright', async () => {
    const page = await browser.newPage({ ignoreHTTPSErrors: true });
    const before = server.refused.length;
    const response = await page.goto('http://example.com/');
    expect(response?.status()).toBe(502);
    expect(await response?.json()).toMatchObject({ refused: 'example.com' });
    await expect(page.goto('https://example.com/')).rejects.toThrow(
      /ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY/,
    );
    // A fixture host over TLS is fine: the tunnel is terminated here.
    const secure = await browser.newPage({ ignoreHTTPSErrors: true });
    expect((await secure.goto('https://brochure.test/'))?.status()).toBe(200);
    await secure.close();
    expect(server.refused.slice(before).map((r) => `${r.method} ${r.host}`)).toEqual([
      'GET example.com',
      'CONNECT example.com',
    ]);
    await page.close();
  });

  it('a path cannot escape its host directory', async () => {
    const page = await browser.newPage();
    const response = await page.goto('http://brochure.test/../../../expected.json');
    expect(response?.status()).toBe(404);
    const encoded = await page.goto('http://brochure.test/%2e%2e/%2e%2e/expected.json');
    expect(encoded?.status()).toBe(404);
    await page.close();
  });
});
