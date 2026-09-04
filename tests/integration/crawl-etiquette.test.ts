import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadBehaviour, scannerUserAgent } from '@gc/config';
import {
  DEEP_SCAN_REFUSED,
  authoriseDeepScan,
  caseTimeline,
  confirmClaim,
  createTestDatabase,
  deepScanAuthorisation,
  openCase,
  requestClaim,
  testDatabaseUrl,
  withTenant,
  type TestDatabase,
} from '@gc/db';
import {
  BrowserPool,
  Etiquette,
  FixtureServer,
  blockedRequests,
  discoverPolicies,
  loadFixtureSites,
  type FixtureHost,
} from '@gc/scanner';

// Crawl etiquette (D-11), against the fixture estate: every request carries the
// header that names us and where to read about us; a crawler-type read announces the
// named user agent; navigations to one host are spaced by the interval the page
// states, wherever in the scanner they come from; robots.txt keeps the crawler off a
// path it disallows, but never off the page asked for; a form submission never leaves;
// a link that asks for agreement first is never followed; and a deep scan runs only
// for a claimed case or a documented public-interest decision.

const spec = loadBehaviour();
const identity = {
  tenantId: 't-1',
  caseId: 'DK-26-0M4K',
  scanId: 'scan-1',
  capturedAt: '2026-09-05T09:14:00Z',
};
const root = mkdtempSync(join(tmpdir(), 'etiquette-'));
const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
const policyText = `<h1>Privacy policy</h1><p>${'We process personal data about you when you shop with us. '.repeat(8)}</p>`;

function host(name: string, files: Record<string, string>): FixtureHost {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return { host: name, dir, routes: [] };
}

const hosts: FixtureHost[] = [
  host('et1.test', {
    'index.html': page(
      'Shop',
      `<main>Welcome.</main><footer><a href="/privacy">Privacy policy</a> <a href="/terms">Terms</a></footer>`,
    ),
    'privacy/index.html': page('Privacy policy', policyText),
    'terms/index.html': page('Terms', `<p>${'Our terms of trade. '.repeat(20)}</p>`),
  }),
  host('et2.test', {
    'robots.txt': 'User-agent: *\nDisallow: /legal/\n',
    'index.html': page('Shop', `<footer><a href="/legal/privacy">Privacy policy</a></footer>`),
    'legal/privacy/index.html': page('Privacy policy', policyText),
  }),
  host('et3.test', {
    'index.html': page(
      'Gate',
      `<footer><a href="/agree?next=privacy">I agree and continue</a></footer><p>Nothing else here.</p>`,
    ),
    'agree/index.html': page('Agreed', policyText),
  }),
  host('et4.test', {
    'index.html': page(
      'Auto submit',
      `<form id="f" method="post" action="/submitted"><input name="email" value="x@y.test"></form><script>document.getElementById('f').submit();</script>`,
    ),
    'submitted/index.html': page('Submitted', '<p>thanks</p>'),
  }),
];

const sites = loadFixtureSites();
let server: FixtureServer;
let pool: BrowserPool;
let etiquette: Etiquette;

beforeAll(async () => {
  server = await new FixtureServer([...sites.flatMap((s) => s.hosts), ...hosts]).start();
  etiquette = new Etiquette({ limits: { minIntervalMs: 300 } });
  pool = await new BrowserPool({
    concurrency: 2,
    passTimeoutMs: 60_000,
    navigationTimeoutMs: 10_000,
    launch: { proxy: { server: server.proxy } },
    ignoreHTTPSErrors: true,
    resolveEgress: false,
    etiquette,
  }).start();
});

afterAll(async () => {
  await pool?.stop();
  await server?.stop();
});

describe('identity', () => {
  it('names itself on every request, and reads a policy as the named crawler', async () => {
    const before = server.served.length;
    const found = await discoverPolicies(pool, { url: 'http://et1.test/' }, { identity });
    expect(found.discovery.observation.outcome).toBe('pass');
    const requests = server.served.slice(before).filter((r) => r.host === 'et1.test');
    expect(requests.length).toBeGreaterThanOrEqual(2);
    for (const r of requests) {
      expect(r.scanner, r.path).toBe(spec.agent.url);
      expect(r.userAgent, r.path).toBe(scannerUserAgent());
    }
  });

  it('a visitor pass carries the header but an ordinary browser user agent', async () => {
    const before = server.served.length;
    await pool.run({ url: 'http://et1.test/' }, async (page) => {
      await page.goto('http://et1.test/', { waitUntil: 'load' });
    });
    const requests = server.served.slice(before).filter((r) => r.host === 'et1.test');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.scanner).toBe(spec.agent.url);
    expect(requests[0]!.userAgent).toMatch(/Mozilla/);
    expect(requests[0]!.userAgent).not.toContain(spec.agent.name);
  });
});

describe('pace and limits', () => {
  it('spaces navigations to one host by the interval, from whichever part of the scanner', async () => {
    const before = server.served.length;
    await pool.run({ url: 'http://et1.test/' }, async (page) => {
      for (const path of ['/', '/privacy', '/terms', '/']) {
        await page.goto(`http://et1.test${path}`, { waitUntil: 'load' });
      }
    });
    const times = server.served
      .slice(before)
      .filter((r) => r.host === 'et1.test')
      .map((r) => r.at);
    expect(times).toHaveLength(4);
    for (let i = 1; i < times.length; i++) {
      expect(times[i]! - times[i - 1]!, `navigation ${i}`).toBeGreaterThanOrEqual(280);
    }
    expect(
      etiquette.navigations.filter((n) => n.host === 'et1.test').length,
    ).toBeGreaterThanOrEqual(4);
  });
});

describe('what it never does', () => {
  it('honours robots.txt for every page beyond the one asked for, and reads it once', async () => {
    const before = server.served.length;
    const found = await discoverPolicies(pool, { url: 'http://et2.test/' }, { identity });
    expect(found.discovery.observation.outcome).toBe('fail');
    const paths = server.served
      .slice(before)
      .filter((r) => r.host === 'et2.test')
      .map((r) => r.path);
    expect(paths.filter((p) => p === '/robots.txt')).toHaveLength(1);
    expect(paths.some((p) => p.startsWith('/legal/'))).toBe(false);
    // The page asked for is read whatever robots.txt says.
    const blocked = await pool.run(
      { url: 'http://et2.test/legal/privacy' },
      async (page, context) => {
        const r = await page.goto('http://et2.test/legal/privacy', { waitUntil: 'load' });
        expect(r?.status()).toBe(200);
        await page.goto('http://et2.test/legal/other').catch(() => undefined);
        return blockedRequests(context);
      },
    );
    expect(blocked.map((b) => [b.url, b.reason])).toContainEqual([
      'http://et2.test/legal/other',
      'robots.txt disallows it',
    ]);
  });

  it('never follows a link that asks for agreement first', async () => {
    const before = server.served.length;
    const found = await discoverPolicies(pool, { url: 'http://et3.test/' }, { identity });
    expect(found.discovery.observation.outcome).toBe('fail');
    const paths = server.served
      .slice(before)
      .filter((r) => r.host === 'et3.test')
      .map((r) => r.path);
    expect(paths.some((p) => p.startsWith('/agree'))).toBe(false);
  });

  it('never submits a form: a page that submits itself is stopped before the request leaves', async () => {
    const before = server.served.length;
    const blocked = await pool.run({ url: 'http://et4.test/' }, async (page, context) => {
      await page.goto('http://et4.test/', { waitUntil: 'load' }).catch(() => undefined);
      await page.waitForTimeout(500);
      return blockedRequests(context);
    });
    expect(blocked.map((b) => b.reason)).toContain('a form submission');
    const posts = server.served
      .slice(before)
      .filter((r) => r.host === 'et4.test' && r.method === 'POST');
    expect(posts).toEqual([]);
    expect(server.served.slice(before).some((r) => r.path === '/submitted')).toBe(false);
  });
});

const url = (() => {
  try {
    return testDatabaseUrl();
  } catch (e) {
    if (process.env['CI']) throw e;
    console.warn((e as Error).message);
    return undefined;
  }
})();

describe.skipIf(!url)('who may run a deep scan', () => {
  let t: TestDatabase;
  const T0 = new Date('2026-09-05T09:14:00Z');
  beforeAll(async () => {
    t = await createTestDatabase(url);
  });
  afterAll(async () => {
    await t?.drop();
  });

  it('a fresh case is refused, a claimed case is allowed by domain control', async () => {
    const opened = await openCase(t, {
      company: { domain: 'eksempelbutik.dk', country: 'DK', locale: 'da' },
      jurisdiction: 'DK',
      locale: 'da',
      now: () => T0,
    });
    expect(await deepScanAuthorisation(t, opened.tenantId, opened.caseId)).toEqual({
      allowed: false,
      reason: DEEP_SCAN_REFUSED,
    });
    const challenge = await requestClaim(t, {
      caseId: opened.caseId,
      tenantId: opened.tenantId,
      email: 'mette@eksempelbutik.dk',
      now: () => T0,
    });
    await confirmClaim(t, {
      caseId: opened.caseId,
      tenantId: opened.tenantId,
      code: challenge.code,
      now: () => new Date(T0.getTime() + 60_000),
    });
    const allowed = await deepScanAuthorisation(t, opened.tenantId, opened.caseId);
    expect(allowed).toMatchObject({
      allowed: true,
      basis: 'domain_control',
      claimedBy: 'mette@eksempelbutik.dk',
    });
  });

  it('a documented public-interest decision allows it, and stands on the timeline with its reason', async () => {
    const opened = await openCase(t, {
      company: { domain: 'kommune.dk', country: 'DK', locale: 'da' },
      jurisdiction: 'DK',
      locale: 'da',
      now: () => T0,
    });
    await expect(
      authoriseDeepScan(t, opened.tenantId, {
        caseId: opened.caseId,
        reason: 'too short',
        by: { kind: 'person', userId: 'u-frits', name: 'Frits' },
      }),
    ).rejects.toThrow(/states its reason/);
    const reason =
      'A public institution whose suppliers process residents’ data; scanned for the canary corpus.';
    await authoriseDeepScan(t, opened.tenantId, {
      caseId: opened.caseId,
      reason,
      by: { kind: 'person', userId: 'u-frits', name: 'Frits' },
      now: T0,
    });
    const allowed = await deepScanAuthorisation(t, opened.tenantId, opened.caseId);
    expect(allowed).toMatchObject({ allowed: true, basis: 'public_interest', reason });
    const events = await withTenant(t, opened.tenantId, (db) => caseTimeline(db, opened.caseId));
    const decision = events.find((e) => e.type === 'deep_scan_authorised')!;
    expect(decision.actor).toEqual({ kind: 'person', userId: 'u-frits', name: 'Frits' });
    expect(decision.payload).toEqual({ reason, basis: 'public_interest' });
  });
});
