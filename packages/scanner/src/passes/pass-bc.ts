import {
  CHOICE_NOT_REMEMBERED_FINDING,
  PassCaptureSchema,
  sha256,
  type ConsentRefusal,
  type ConsentStep,
  type Evidence,
  type PassCapture,
} from '@gc/contracts';
import type { Page } from 'playwright';
import { acceptOnPage, findBanner, refuseOnPage } from '../consent/banner.js';
import type { EvidenceIdentity } from '../evidence.js';
import type { BrowserPool, ScanTarget } from '../pool.js';
import { collectPassA, type PassAOptions, type PassAResult } from './pass-a.js';
import { instrument, type Instrumented } from './instrument.js';
import { DEFAULT_QUIET, watchNetwork, type QuietOptions } from './network-quiet.js';

// Pass B and Pass C (S-04): the same capture as Pass A, taken after the visitor has
// said no (B) or yes (C). The choice is made on the first load, then the page is
// reloaded and only the reload is recorded: what a visitor who refused, or agreed,
// gets on their next page. Whether the choice was registered is checked, not assumed:
// something was written to remember it, and the banner does not come back. A banner
// that forgets is a finding. Pass C's hosts are the permitted vendor set.

export interface PassBCOptions {
  readonly identity: EvidenceIdentity;
  readonly quiet?: Partial<QuietOptions>;
  readonly now?: () => Date;
  readonly settleMs?: number;
}

export interface PassBResult {
  readonly capture: PassCapture;
  readonly screenshot: Uint8Array;
  readonly refusal: ConsentRefusal;
  readonly evidence: readonly Evidence[];
}

export interface PassCResult {
  readonly capture: PassCapture;
  readonly screenshot: Uint8Array;
  readonly steps: readonly ConsentStep[];
  readonly evidence: readonly Evidence[];
  // Every third-party host contacted once everything is allowed: the inventory.
  readonly vendorHosts: readonly string[];
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return url;
  }
};

// Hosts other than the page's own, from a capture.
export function vendorHostsOf(capture: PassCapture): string[] {
  const own = hostOf(capture.finalUrl);
  const bare = own.replace(/^www\./, '');
  return [
    ...new Set(
      capture.requests
        .map((r) => r.host)
        .filter((h) => h !== own && h !== bare && !h.endsWith(`.${bare}`)),
    ),
  ].sort();
}

// What was written to remember the choice: cookies and storage keys that appeared
// after the first load began. Read before the reload so the reload cannot add to it.
async function consentRecord(
  seen: Instrumented,
  before: { cookies: Set<string>; storage: Set<string> },
): Promise<{ cookies: string[]; storage: string[] }> {
  const cookies = (await seen.cookies()).map((c) => c.name).filter((n) => !before.cookies.has(n));
  const storage = (await seen.storage()).storage
    .map((w) => `${w.area}:${w.key}`)
    .filter((k) => !before.storage.has(k));
  return { cookies: [...new Set(cookies)].sort(), storage: [...new Set(storage)].sort() };
}

async function reloadAndCapture(
  page: Page,
  seen: Instrumented,
  target: ScanTarget,
  pass: 'B' | 'C',
  quiet: QuietOptions,
  consent: PassCapture['consent'],
): Promise<{ capture: PassCapture; screenshot: Uint8Array }> {
  seen.mark();
  const startedAt = seen.startedAt();
  const watch = watchNetwork(page.context(), startedAt, quiet);
  const response = await page.reload({ waitUntil: 'load' });
  const quietResult = await watch.settle();
  const requests = await seen.requests();
  const cookies = await seen.cookies();
  const { storage, frames } = await seen.storage();
  const screenshot = await page.screenshot({ fullPage: true, type: 'png' });
  const capture = PassCaptureSchema.parse({
    pass,
    url: target.url,
    finalUrl: page.url(),
    document: await seen.document(response),
    ...(response ? { status: response.status() } : {}),
    startedAt: new Date(startedAt).toISOString(),
    frames,
    requests,
    cookies,
    storage,
    screenshotHash: sha256(Buffer.from(screenshot).toString('base64')),
    quiet: quietResult,
    consent,
  });
  return { capture, screenshot };
}

export async function collectPassB(
  pool: BrowserPool,
  target: ScanTarget,
  options: PassBCOptions,
): Promise<PassBResult> {
  const quiet = { ...DEFAULT_QUIET, ...options.quiet };
  return pool.run(target, async (page, context) => {
    const seen = await instrument(page, context);
    await page.goto(target.url, { waitUntil: 'load' });
    const before = {
      cookies: new Set((await seen.cookies()).map((c) => c.name)),
      storage: new Set((await seen.storage()).storage.map((w) => `${w.area}:${w.key}`)),
    };
    const { refusal, evidence } = await refuseOnPage(page, target.url, {
      identity: options.identity,
      pass: 'B',
      ...(options.now ? { now: options.now } : {}),
      ...(options.settleMs !== undefined ? { settleMs: options.settleMs } : {}),
    });
    const recordedIn = await consentRecord(seen, before);

    // The choice is registered when the banner stays away on the next load.
    const { capture: reloaded, screenshot } = await reloadAndCapture(
      page,
      seen,
      target,
      'B',
      quiet,
      undefined,
    );
    const rememberedAfterReload = refusal.outcome !== 'refused' ? false : !(await findBanner(page));
    const consent: NonNullable<PassCapture['consent']> = {
      action: 'refuse',
      outcome: refusal.outcome,
      ...(refusal.platform ? { platform: refusal.platform } : {}),
      steps: refusal.steps.length,
      recordedIn,
      rememberedAfterReload,
      ...(refusal.outcome === 'refused' && !rememberedAfterReload
        ? { finding: { findingTypeId: CHOICE_NOT_REMEMBERED_FINDING } }
        : {}),
    };
    const capture = PassCaptureSchema.parse({ ...reloaded, consent });
    return { capture, screenshot, refusal, evidence };
  });
}

export async function collectPassC(
  pool: BrowserPool,
  target: ScanTarget,
  options: PassBCOptions,
): Promise<PassCResult> {
  const quiet = { ...DEFAULT_QUIET, ...options.quiet };
  return pool.run(target, async (page, context) => {
    const seen = await instrument(page, context);
    await page.goto(target.url, { waitUntil: 'load' });
    const before = {
      cookies: new Set((await seen.cookies()).map((c) => c.name)),
      storage: new Set((await seen.storage()).storage.map((w) => `${w.area}:${w.key}`)),
    };
    const accepted = await acceptOnPage(page, {
      identity: options.identity,
      pass: 'C',
      ...(options.now ? { now: options.now } : {}),
      ...(options.settleMs !== undefined ? { settleMs: options.settleMs } : {}),
    });
    const recordedIn = await consentRecord(seen, before);
    const { capture: reloaded, screenshot } = await reloadAndCapture(
      page,
      seen,
      target,
      'C',
      quiet,
      undefined,
    );
    const rememberedAfterReload = accepted.accepted ? !(await findBanner(page)) : false;
    const consent: NonNullable<PassCapture['consent']> = {
      action: 'accept',
      outcome: !accepted.bannerFound
        ? 'no_banner'
        : accepted.accepted
          ? 'accepted'
          : 'undetermined',
      ...(accepted.platform ? { platform: accepted.platform } : {}),
      steps: accepted.steps.length,
      recordedIn,
      rememberedAfterReload,
      ...(accepted.accepted && !rememberedAfterReload
        ? { finding: { findingTypeId: CHOICE_NOT_REMEMBERED_FINDING } }
        : {}),
    };
    const capture = PassCaptureSchema.parse({ ...reloaded, consent });
    return {
      capture,
      screenshot,
      steps: accepted.steps,
      evidence: accepted.evidence,
      vendorHosts: vendorHostsOf(capture),
    };
  });
}

export interface AllPasses {
  readonly a: PassAResult;
  readonly b: PassBResult;
  readonly c: PassCResult;
  readonly durationMs: number;
}

// The three passes at once, each on its own context; the pool's concurrency decides
// how many actually run in parallel.
export async function collectPasses(
  pool: BrowserPool,
  target: ScanTarget,
  options: PassBCOptions & Pick<PassAOptions, 'inspect'>,
): Promise<AllPasses> {
  const started = Date.now();
  const [a, b, c] = await Promise.all([
    collectPassA(pool, target, {
      ...(options.quiet ? { quiet: options.quiet } : {}),
      ...(options.inspect ? { inspect: options.inspect } : {}),
    }),
    collectPassB(pool, target, options),
    collectPassC(pool, target, options),
  ]);
  return { a, b, c, durationMs: Date.now() - started };
}
