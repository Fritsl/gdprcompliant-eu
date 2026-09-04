import {
  PassCaptureSchema,
  sha256,
  type CapturedCookie,
  type CapturedRequest,
  type PassCapture,
  type StorageWrite,
} from '@gc/contracts';
import type { BrowserContext, Page, Request } from 'playwright';
import type { BrowserPool, ScanTarget } from '../pool.js';
import { DEFAULT_QUIET, watchNetwork, type QuietOptions } from './network-quiet.js';

// Pass A: load, wait for network quiet, touch nothing. Every request with the chain of
// scripts that caused it, every cookie the browser ends up holding, every write to web
// storage, and a full-page screenshot. The result is data; judgement is the differ's.

export interface PassAResult {
  readonly capture: PassCapture;
  readonly screenshot: Uint8Array;
}

export interface PassAOptions {
  readonly quiet?: Partial<QuietOptions>;
  // Called with the live page after the capture is taken and before the context closes;
  // for tests that want to look at the page as the pass left it.
  readonly inspect?: (page: Page, context: BrowserContext) => Promise<void>;
}

interface Initiator {
  type: 'parser' | 'script' | 'preload' | 'preflight' | 'other';
  url?: string;
  line?: number;
  stack: string[];
}

// Installed in every frame before any script runs: records writes to web storage as
// they happen, so a value set and then removed is still seen.
const RECORD_STORAGE_WRITES = `(() => {
  const writes = [];
  window.__gcStorageWrites = writes;
  const origin = location.origin;
  const t0 = performance.timeOrigin;
  for (const [area, store] of [['local', window.localStorage], ['session', window.sessionStorage]]) {
    const proto = Object.getPrototypeOf(store);
    const setItem = proto.setItem;
    proto.setItem = function (key, value) {
      if (this === store) writes.push({ origin, area, key: String(key), value: String(value), atMs: Date.now() - t0 });
      return setItem.call(this, key, value);
    };
  }
})();`;

// Evaluated in every frame at the end: what was written, and what is there now.
const READ_STORAGE_STATE = `({
  writes: window.__gcStorageWrites ?? [],
  local: Object.entries(localStorage),
  session: Object.entries(sessionStorage),
  origin: location.origin,
})`;

function initiatorType(type: string): Initiator['type'] {
  return type === 'parser' || type === 'script' || type === 'preload' || type === 'preflight'
    ? type
    : 'other';
}

export async function collectPassA(
  pool: BrowserPool,
  target: ScanTarget,
  options: PassAOptions = {},
): Promise<PassAResult> {
  const quiet = { ...DEFAULT_QUIET, ...options.quiet };
  return pool.run(target, async (page, context) => {
    await context.addInitScript(RECORD_STORAGE_WRITES);

    // Initiators come from the devtools protocol: who asked for each URL, with the script
    // stack when a script did. Chromium only, which the scanner is.
    const initiators = new Map<string, Initiator>();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    cdp.on('Network.requestWillBeSent', (event) => {
      const init = event.initiator;
      const stack = (init.stack?.callFrames ?? []).map((f) => f.url).filter((u) => u !== '');
      const url = init.url ?? stack[0];
      initiators.set(event.request.url, {
        type: initiatorType(init.type),
        ...(url !== undefined ? { url } : {}),
        ...(init.lineNumber !== undefined ? { line: init.lineNumber + 1 } : {}),
        stack: [...new Set(stack)],
      });
    });

    const startedAt = Date.now();
    const seen: Request[] = [];
    const failures = new Map<Request, string>();
    context.on('request', (r) => seen.push(r));
    context.on('requestfailed', (r) => failures.set(r, r.failure()?.errorText ?? 'failed'));
    const watch = watchNetwork(context, startedAt, quiet);

    const response = await page.goto(target.url, { waitUntil: 'load' });
    const quietResult = await watch.settle();

    const requests: CapturedRequest[] = [];
    for (const r of seen) {
      const url = r.url();
      const init = initiators.get(url) ?? { type: 'other' as const, stack: [] };
      const chain = chainFor(url, initiators);
      const timing = r.timing();
      const res = failures.has(r) ? null : await r.response().catch(() => null);
      const sizes = res
        ? await res
            .request()
            .sizes()
            .catch(() => undefined)
        : undefined;
      const started = timing.startTime > 0 ? Math.max(0, timing.startTime - startedAt) : 0;
      requests.push({
        url,
        host: hostOf(url),
        method: r.method(),
        resourceType: resourceTypeOf(r.resourceType()),
        frameUrl: r.frame().url(),
        initiator: {
          type: init.type,
          ...(init.url !== undefined ? { url: init.url } : {}),
          ...(init.line !== undefined ? { line: init.line } : {}),
        },
        chain,
        ...(r.redirectedFrom() ? { redirectedFrom: r.redirectedFrom()!.url() } : {}),
        startedAtMs: started,
        ...(timing.responseEnd >= 0 ? { durationMs: timing.responseEnd } : {}),
        ...(res ? { status: res.status() } : {}),
        ...(failures.has(r) ? { failed: failures.get(r)! } : {}),
        ...(sizes ? { sizeBytes: sizes.responseBodySize + sizes.responseHeadersSize } : {}),
      });
    }

    const cookies: CapturedCookie[] = (await context.cookies()).map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite,
    }));

    const storage: StorageWrite[] = [];
    const frames: string[] = [];
    for (const frame of page.frames()) {
      frames.push(frame.url());
      const seenInFrame = await frame
        .evaluate<{
          writes: StorageWrite[];
          local: [string, string][];
          session: [string, string][];
          origin: string;
        }>(READ_STORAGE_STATE)
        .catch(() => null);
      if (!seenInFrame) continue;
      storage.push(...seenInFrame.writes);
      // Anything present at the end that no setItem call explained — set by property
      // assignment, or before the init script ran — is recorded with an unknown time.
      for (const [area, entries] of [
        ['local', seenInFrame.local],
        ['session', seenInFrame.session],
      ] as const) {
        for (const [key, value] of entries) {
          if (
            !seenInFrame.writes.some((w) => w.area === area && w.key === key && w.value === value)
          ) {
            storage.push({ origin: seenInFrame.origin, area, key, value, atMs: -1 });
          }
        }
      }
    }

    const screenshot = await page.screenshot({ fullPage: true, type: 'png' });
    if (options.inspect) await options.inspect(page, context);

    const documentLang = await page
      .evaluate(
        () =>
          (globalThis as unknown as { document: { documentElement: { lang: string } } }).document
            .documentElement.lang || '',
      )
      .catch(() => '');
    const documentTitle = await page.title().catch(() => '');
    const contentLanguage = response?.headers()['content-language'];
    const capture = PassCaptureSchema.parse({
      pass: 'A',
      url: target.url,
      finalUrl: page.url(),
      document: {
        ...(documentLang ? { lang: documentLang } : {}),
        ...(contentLanguage ? { contentLanguage } : {}),
        ...(documentTitle ? { title: documentTitle } : {}),
      },
      ...(response ? { status: response.status() } : {}),
      startedAt: new Date(startedAt).toISOString(),
      frames,
      requests,
      cookies,
      storage,
      // The evidence row stores the PNG as base64, so the hash is over that: the same
      // bytes a finding will point at.
      screenshotHash: sha256(Buffer.from(screenshot).toString('base64')),
      quiet: quietResult,
    });
    return { capture, screenshot };
  });
}

function chainFor(url: string, initiators: Map<string, Initiator>): string[] {
  const chain: string[] = [];
  const seen = new Set<string>([url]);
  let current = initiators.get(url);
  while (current) {
    const next = current.url ?? current.stack[0];
    if (next === undefined || seen.has(next)) break;
    chain.push(next);
    seen.add(next);
    current = initiators.get(next);
  }
  return chain;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return url;
  }
}

const RESOURCE = new Set([
  'document',
  'stylesheet',
  'image',
  'media',
  'font',
  'script',
  'texttrack',
  'xhr',
  'fetch',
  'eventsource',
  'websocket',
  'manifest',
]);

function resourceTypeOf(type: string): CapturedRequest['resourceType'] {
  return (RESOURCE.has(type) ? type : 'other') as CapturedRequest['resourceType'];
}
