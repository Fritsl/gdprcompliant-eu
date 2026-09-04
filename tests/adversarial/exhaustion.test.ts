import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BrowserPool,
  FixtureServer,
  collectPassA,
  discoverPolicies,
  loadFixtureSites,
  runChecks,
} from '@gc/scanner';

// Resource exhaustion (T-06): a site that never arrives, one that never stops, one that
// is enormous, and one that hides an archive bomb behind its policy link. The scanner
// gives up on its own clock, keeps a bounded amount, downloads nothing, and the browser
// behind it survives every one of them.

const sites = loadFixtureSites();
const identity = {
  tenantId: 't-adv',
  caseId: 'DK-26-EXHA',
  scanId: 'adv-exhaust',
  capturedAt: '2026-09-04T09:14:00Z',
};
const quiet = { minDwellMs: 300, quietMs: 300, maxWaitMs: 4_000 };
const NAV_MS = 8_000;
const PASS_MS = 30_000;
let server: FixtureServer;
let pool: BrowserPool;

const timed = async <T>(work: Promise<T>): Promise<{ ms: number; result?: T; error?: Error }> => {
  const t0 = Date.now();
  try {
    return { ms: Date.now() - t0, result: await work };
  } catch (e) {
    return { ms: Date.now() - t0, error: e as Error };
  }
};

beforeAll(async () => {
  server = await new FixtureServer(sites.flatMap((s) => s.hosts)).start();
  pool = await new BrowserPool({
    concurrency: 2,
    passTimeoutMs: PASS_MS,
    navigationTimeoutMs: NAV_MS,
    launch: { proxy: { server: server.proxy } },
    ignoreHTTPSErrors: true,
    resolveEgress: false,
  }).start();
});

afterAll(async () => {
  await pool?.stop();
  await server?.stop();
});

describe('a site that fights back', () => {
  it('a redirect loop is given up on quickly and said so, and the browser is intact', async () => {
    const r = await timed(collectPassA(pool, { url: 'https://loop.shop.test/' }, { quiet }));
    expect(r.error, 'the loop must not look like a page').toBeDefined();
    expect(r.error!.message).toMatch(/redirect|ERR_TOO_MANY_REDIRECTS|Timeout/i);
    expect(r.ms).toBeLessThan(NAV_MS + 5_000);
    expect(pool.stats().killed).toBe(0);
  }, 60_000);

  it('a server that stalls is cut off on our clock, not its own', async () => {
    const r = await timed(collectPassA(pool, { url: 'https://slow.shop.test/' }, { quiet }));
    expect(r.error).toBeDefined();
    expect(r.ms).toBeGreaterThanOrEqual(NAV_MS - 500);
    expect(r.ms).toBeLessThan(NAV_MS + 5_000);
    expect(pool.stats().killed).toBe(0);
  }, 60_000);

  it('an enormous document is scanned inside the budget and only a bounded part of it is kept', async () => {
    const r = await timed(
      runChecks(
        pool,
        { url: 'https://huge.shop.test/' },
        { identity, families: ['security', 'policies'], quiet },
      ),
    );
    expect(r.ms).toBeLessThan(120_000);
    if (r.result) {
      for (const e of r.result.evidence) {
        expect(e.body.length, `${e.id} (${e.kind})`).toBeLessThan(1_000_000);
      }
    } else {
      // Cut off by the pass deadline: also an answer, as long as it came in time.
      expect(r.error!.message).toMatch(/exceeded|Timeout|timeout/);
    }
    expect(pool.stats().killed).toBe(0);
  }, 150_000);

  it('an archive bomb behind the policy link is never downloaded and never mistaken for a policy', async () => {
    const before = server.served.filter((s) => s.path === '/privatlivspolitik.zip').length;
    const r = await timed(
      discoverPolicies(
        pool,
        { url: 'https://bomb.shop.test/' },
        { identity, now: () => new Date(identity.capturedAt) },
      ),
    );
    expect(r.ms).toBeLessThan(PASS_MS + 5_000);
    if (r.result) {
      for (const d of r.result.discovery.documents ?? []) {
        expect(d.url).not.toMatch(/\.zip$/);
      }
      for (const e of r.result.evidence) expect(e.body.length).toBeLessThan(1_000_000);
    }
    // The link may be followed once by a browser that then refuses the download; the
    // bytes are not kept, and nothing loops back for more.
    const fetched =
      server.served.filter((s) => s.path === '/privatlivspolitik.zip').length - before;
    expect(fetched).toBeLessThanOrEqual(2);
    expect(pool.stats().killed).toBe(0);
  }, 90_000);
});
