import { PassCaptureSchema, sha256, type PassCapture } from '@gc/contracts';
import type { BrowserContext, Page } from 'playwright';
import type { BrowserPool, ScanTarget } from '../pool.js';
import { instrument } from './instrument.js';
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

export async function collectPassA(
  pool: BrowserPool,
  target: ScanTarget,
  options: PassAOptions = {},
): Promise<PassAResult> {
  const quiet = { ...DEFAULT_QUIET, ...options.quiet };
  return pool.run(target, async (page, context) => {
    const seen = await instrument(page, context);
    const startedAt = seen.startedAt();
    const watch = watchNetwork(context, startedAt, quiet);

    const response = await page.goto(target.url, { waitUntil: 'load' });
    const quietResult = await watch.settle();

    const requests = await seen.requests();
    const cookies = await seen.cookies();
    const { storage, frames } = await seen.storage();

    const screenshot = await page.screenshot({ fullPage: true, type: 'png' });
    if (options.inspect) await options.inspect(page, context);

    const capture = PassCaptureSchema.parse({
      pass: 'A',
      url: target.url,
      finalUrl: page.url(),
      document: await seen.document(response),
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
