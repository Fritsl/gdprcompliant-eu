import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixtureServer, loadFixtureSites, type FixtureSite } from '@gc/scanner';

// The fixture estate, end to end: every host served by the fixture server, a real
// Chromium sent through it as its proxy, and each fixture's first-load network
// expectation checked against what the browser actually requested. Nothing reaches the
// internet: a stranger gets a 502, TLS gets refused.

const sites = loadFixtureSites();
let server: FixtureServer;
let browser: Browser;

beforeAll(async () => {
  server = await new FixtureServer(sites.flatMap((s) => s.hosts)).start();
  browser = await chromium.launch({ proxy: { server: server.proxy } });
});

afterAll(async () => {
  await browser?.close();
  await server?.stop();
});

async function firstLoad(
  site: FixtureSite,
): Promise<{ page: Page; hosts: Set<string>; failed: string[] }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const hosts = new Set<string>();
  const failed: string[] = [];
  page.on('request', (r) => hosts.add(new URL(r.url()).hostname));
  page.on('requestfailed', (r) => failed.push(`${r.url()} ${r.failure()?.errorText ?? ''}`));
  const response = await page.goto(`http://${site.expected.site}/`, { waitUntil: 'networkidle' });
  expect(response?.status(), site.name).toBe(200);
  return { page, hosts, failed };
}

describe('fixture sites through the proxy (F-07)', () => {
  it('serves every fixture host and refuses everything else', () => {
    expect(server.hostNames()).toEqual(
      expect.arrayContaining(['eksempelbutik.test', 'analytics.tracker.test', 'brochure.test']),
    );
  });

  for (const site of sites) {
    it(`${site.name}: the first load contacts exactly what expected.json says`, async () => {
      const { page, hosts, failed } = await firstLoad(site);
      const { mustContact, mustNotContact } = site.expected.network.firstLoad;
      for (const h of mustContact) expect(hosts, `${site.name} never contacted ${h}`).toContain(h);
      for (const h of mustNotContact) expect(hosts, `${site.name} contacted ${h}`).not.toContain(h);
      // Every request the page made went to a fixture host, and none of them failed.
      const own = new Set(site.hosts.map((h) => h.host));
      for (const h of hosts) expect(own.has(h), `${site.name} reached ${h}`).toBe(true);
      expect(failed).toEqual([]);
      await page.context().close();
    });
  }

  it('the reference fixture actually has the bug: the tag fires before any consent', async () => {
    const site = sites.find((s) => s.name === 'reject-not-honoured')!;
    const { page, hosts } = await firstLoad(site);
    expect(hosts).toContain('analytics.tracker.test');
    expect(await page.locator('#cmp').isVisible()).toBe(true);
    const cookies = await page.context().cookies();
    expect(cookies.map((c) => c.name)).toContain('_trk');
    expect(
      server.served.some(
        (s) => s.host === 'analytics.tracker.test' && s.path === '/collect' && s.status === 204,
      ),
    ).toBe(true);
    await page.context().close();
  });

  it('the clean control loads nothing from anyone and sets no cookie', async () => {
    const site = sites.find((s) => s.name === 'clean-brochure')!;
    const { page, hosts } = await firstLoad(site);
    expect([...hosts]).toEqual(['brochure.test']);
    expect(await page.context().cookies()).toEqual([]);
    expect(await page.evaluate(() => localStorage.length)).toBe(0);
    await page.context().close();
  });

  it('a host outside the fixture is refused with a 502, and TLS is refused outright', async () => {
    const page = await browser.newPage();
    const before = server.refused.length;
    const response = await page.goto('http://example.com/');
    expect(response?.status()).toBe(502);
    expect(await response?.json()).toMatchObject({ refused: 'example.com' });
    await expect(page.goto('https://example.com/')).rejects.toThrow(
      /ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY/,
    );
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
