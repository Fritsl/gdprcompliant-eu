import type { CapturedCookie, CapturedRequest, PassCapture, StorageWrite } from '@gc/contracts';
import type { BrowserContext, Page, Request, Response } from 'playwright';

// What every pass records, the same way: each request with the chain of scripts that
// caused it (from the devtools protocol, Chromium only, which the scanner is), the
// cookies the browser ends up holding, every write to web storage, and what the
// document says about itself. A pass marks a phase boundary when it wants "what
// happened after this point", which is how Pass B and Pass C see the reload alone.

interface Initiator {
  type: 'parser' | 'script' | 'preload' | 'preflight' | 'other';
  url?: string;
  line?: number;
  stack: string[];
}

// Installed in every frame before any script runs: records writes to web storage as
// they happen, so a value set and then removed is still seen.
export const RECORD_STORAGE_WRITES = `(() => {
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

export function hostOf(url: string): string {
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

export interface Instrumented {
  // When the current phase began, in epoch milliseconds.
  readonly startedAt: () => number;
  // Start a new phase: requests seen so far are forgotten, the clock restarts.
  readonly mark: () => void;
  readonly requests: () => Promise<CapturedRequest[]>;
  readonly cookies: () => Promise<CapturedCookie[]>;
  readonly storage: () => Promise<{ storage: StorageWrite[]; frames: string[] }>;
  readonly document: (response: Response | null) => Promise<PassCapture['document']>;
}

export async function instrument(page: Page, context: BrowserContext): Promise<Instrumented> {
  await context.addInitScript(RECORD_STORAGE_WRITES);

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

  let startedAt = Date.now();
  let seen: Request[] = [];
  const failures = new Map<Request, string>();
  context.on('request', (r) => seen.push(r));
  context.on('requestfailed', (r) => failures.set(r, r.failure()?.errorText ?? 'failed'));

  return {
    startedAt: () => startedAt,
    mark: () => {
      startedAt = Date.now();
      seen = [];
    },
    requests: async () => {
      const out: CapturedRequest[] = [];
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
        out.push({
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
      return out;
    },
    cookies: async () =>
      (await context.cookies()).map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expires: c.expires,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite,
      })),
    storage: async () => {
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
      return { storage, frames };
    },
    document: async (response) => {
      const lang = await page
        .evaluate(
          () =>
            (globalThis as unknown as { document: { documentElement: { lang: string } } }).document
              .documentElement.lang || '',
        )
        .catch(() => '');
      const title = await page.title().catch(() => '');
      const contentLanguage = response?.headers()['content-language'];
      return {
        ...(lang ? { lang } : {}),
        ...(contentLanguage ? { contentLanguage } : {}),
        ...(title ? { title } : {}),
      };
    },
  };
}
