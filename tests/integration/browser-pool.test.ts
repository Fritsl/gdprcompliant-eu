import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BrowserPool,
  DEFAULT_VISITOR,
  FixtureServer,
  PassTimeoutError,
  loadFixtureSites,
} from '@gc/scanner';

// The pool, against the fixture estate plus one host built here that writes every kind
// of state a browser can hold. Profile bleed would silently invalidate the three-pass
// diff, so isolation is proven, not assumed.

// Served on localhost, which browsers treat as a secure context (service workers need one)
// and reach directly rather than through the proxy.
const STATE_HOST = 'localhost';
const stateUrl = () => `http://localhost:${server.port}`;
const stateDir = mkdtempSync(join(tmpdir(), 'state-'));
writeFileSync(
  join(stateDir, 'index.html'),
  `<!doctype html><html><head><meta charset="utf-8"><title>state</title></head><body>
  <script>
    document.cookie = 'seen=1; path=/; max-age=3600';
    localStorage.setItem('seen', '1');
    sessionStorage.setItem('seen', '1');
    window.__ready = (async () => {
      await new Promise((resolve, reject) => {
        const open = indexedDB.open('seen', 1);
        open.onupgradeneeded = () => open.result.createObjectStore('s');
        open.onsuccess = () => { const tx = open.result.transaction('s', 'readwrite'); tx.objectStore('s').put(1, 'k'); tx.oncomplete = () => resolve(); tx.onerror = reject; };
        open.onerror = reject;
      });
      await fetch('/cached.txt');
      await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      return true;
    })();
  </script></body></html>`,
);
writeFileSync(
  join(stateDir, 'blank.html'),
  '<!doctype html><html><head><meta charset="utf-8"><title>blank</title></head><body></body></html>',
);
writeFileSync(
  join(stateDir, 'sw.js'),
  'self.addEventListener("install", () => self.skipWaiting());',
);

// What a page can see of its own profile.
const readState = `(async () => ({
  cookie: document.cookie,
  local: localStorage.length,
  session: sessionStorage.length,
  idb: await new Promise((resolve) => { const r = indexedDB.databases ? indexedDB.databases() : Promise.resolve([]); r.then((d) => resolve(d.length)).catch(() => resolve(-1)); }),
  workers: (await navigator.serviceWorker.getRegistrations()).length,
}))()`;

const sites = loadFixtureSites();
let server: FixtureServer;
let pool: BrowserPool;

const launch = () => ({ proxy: { server: server.proxy } });

beforeAll(async () => {
  server = await new FixtureServer([
    ...sites.flatMap((s) => s.hosts),
    {
      host: STATE_HOST,
      dir: stateDir,
      routes: [
        {
          path: '/cached.txt',
          status: 200,
          headers: { 'content-type': 'text/plain', 'cache-control': 'max-age=3600' },
          body: 'cached',
        },
      ],
    },
  ]).start();
  pool = await new BrowserPool({
    concurrency: 2,
    passTimeoutMs: 20_000,
    navigationTimeoutMs: 10_000,
    launch: launch(),
  }).start();
});

afterAll(async () => {
  await pool?.stop();
  await server?.stop();
});

const cachedHits = () =>
  server.served.filter((s) => s.host === STATE_HOST && s.path === '/cached.txt').length;

describe('clean-profile isolation (S-01)', () => {
  it('pass N cannot observe any state written during pass N-1', async () => {
    const url = `${stateUrl()}/`;
    const before = cachedHits();

    const written = await pool.run({ url }, async (page) => {
      await page.goto(url);
      await page.waitForFunction(
        () => (window as unknown as { __ready: Promise<boolean> }).__ready,
      );
      return page.evaluate(readState) as Promise<Record<string, unknown>>;
    });
    expect(written).toEqual({ cookie: 'seen=1', local: 1, session: 1, idb: 1, workers: 1 });
    expect(cachedHits()).toBe(before + 1);
    expect(pool.stats().contextsOpen).toBe(0);

    const seen = await pool.run({ url }, async (page, context) => {
      expect(await context.cookies()).toEqual([]);
      await page.goto(`${stateUrl()}/blank.html`);
      const state = (await page.evaluate(readState)) as Record<string, unknown>;
      // The cache is fresh too: the same resource is fetched from the server again.
      await page.evaluate(() => fetch('/cached.txt'));
      return state;
    });
    expect(seen).toEqual({ cookie: '', local: 0, session: 0, idb: 0, workers: 0 });
    expect(cachedHits()).toBe(before + 2);
  });
});

describe('limits and deadlines (S-01)', () => {
  it('never runs more passes at once than the concurrency limit', async () => {
    let now = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        pool.run({ url: 'http://brochure.test/' }, async (page) => {
          now++;
          peak = Math.max(peak, now);
          await page.goto('http://brochure.test/');
          await new Promise((r) => setTimeout(r, 150));
          now--;
        }),
      ),
    );
    expect(peak).toBe(2);
    expect(pool.stats().peakInFlight).toBe(2);
    expect(pool.stats().contextsOpen).toBe(0);
  });

  it('a pass that hangs is cut off at the deadline and its context is gone', async () => {
    const short = await new BrowserPool({
      concurrency: 1,
      passTimeoutMs: 800,
      navigationTimeoutMs: 500,
      launch: launch(),
    }).start();
    try {
      const started = Date.now();
      await expect(
        short.run({ url: 'http://brochure.test/' }, () => new Promise<never>(() => undefined)),
      ).rejects.toThrow(PassTimeoutError);
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(short.stats()).toMatchObject({ timedOut: 1, contextsOpen: 0, inFlight: 0 });

      // A navigation that never completes trips the per-navigation timeout, not the deadline.
      await expect(
        short.run({ url: 'http://brochure.test/slow' }, async (page, context) => {
          await context.route('**/slow', () => undefined);
          await page.goto('http://brochure.test/slow');
        }),
      ).rejects.toThrow(/Timeout 500ms exceeded/);

      // And the pool is still usable afterwards.
      const title = await short.run({ url: 'http://brochure.test/' }, async (page) => {
        await page.goto('http://brochure.test/');
        return page.title();
      });
      expect(title).toBe('Tømrer Jensen');
    } finally {
      await short.stop();
    }
  });

  it('a browser that will not close a context is killed, and the next pass gets a fresh one', async () => {
    const twitchy = await new BrowserPool({
      concurrency: 1,
      passTimeoutMs: 5_000,
      navigationTimeoutMs: 2_000,
      closeTimeoutMs: 300,
      launch: launch(),
    }).start();
    try {
      await twitchy.run({ url: 'http://brochure.test/' }, async (page, context) => {
        await page.goto('http://brochure.test/');
        // Simulate a wedged browser: closing this context never returns.
        context.close = () => new Promise<void>(() => undefined);
      });
      expect(twitchy.stats().killed).toBe(1);
      const title = await twitchy.run({ url: 'http://brochure.test/' }, async (page) => {
        await page.goto('http://brochure.test/');
        return page.title();
      });
      expect(title).toBe('Tømrer Jensen');
      expect(twitchy.stats()).toMatchObject({ killed: 1, completed: 2, contextsOpen: 0 });
    } finally {
      await twitchy.stop();
    }
  });
});

describe('the visitor (S-01)', () => {
  const probe = (page: import('playwright').Page) =>
    page.evaluate(() => ({
      language: navigator.language,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      width: window.innerWidth,
      height: window.innerHeight,
    }));

  it('looks like a real person in the target country by default', async () => {
    const seen = await pool.run({ url: 'http://brochure.test/' }, async (page) => {
      await page.goto('http://brochure.test/');
      return probe(page);
    });
    expect(seen).toEqual({
      language: DEFAULT_VISITOR.locale,
      timezone: DEFAULT_VISITOR.timezone,
      width: DEFAULT_VISITOR.viewport.width,
      height: DEFAULT_VISITOR.viewport.height,
    });
  });

  it('is configurable per scan target', async () => {
    const seen = await pool.run(
      {
        url: 'http://brochure.test/',
        locale: 'de-DE',
        timezone: 'Europe/Berlin',
        viewport: { width: 390, height: 844 },
      },
      async (page) => {
        await page.goto('http://brochure.test/');
        return probe(page);
      },
    );
    expect(seen).toEqual({ language: 'de-DE', timezone: 'Europe/Berlin', width: 390, height: 844 });
  });
});

describe('memory (S-01)', () => {
  it('stays flat across 200 sequential scans, with no context left behind', async () => {
    const heap: number[] = [];
    for (let i = 0; i < 200; i++) {
      await pool.run({ url: 'http://brochure.test/' }, async (page) => {
        await page.goto('http://brochure.test/', { waitUntil: 'load' });
      });
      expect(pool.stats().contextsOpen).toBe(0);
      heap.push(process.memoryUsage().heapUsed);
    }
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const early = mean(heap.slice(20, 60));
    const late = mean(heap.slice(160, 200));
    expect(late / early, `heap grew from ${early} to ${late}`).toBeLessThan(1.5);
    expect(pool.stats().killed).toBe(0);
  }, 180_000);
});
