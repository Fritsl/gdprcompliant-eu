import type { NetworkQuiet } from '@gc/contracts';
import type { BrowserContext } from 'playwright';

// The network-quiet heuristic: watch at least minDwellMs, then require quietMs of
// silence, never longer than maxWaitMs. Why these numbers: docs/decisions/network-quiet.md.

export interface QuietOptions {
  readonly minDwellMs: number;
  readonly quietMs: number;
  readonly maxWaitMs: number;
}

export const DEFAULT_QUIET: QuietOptions = { minDwellMs: 5_000, quietMs: 1_500, maxWaitMs: 15_000 };

export interface NetworkWatch {
  // Resolves when the page has gone quiet, or the cap is reached.
  readonly settle: () => Promise<NetworkQuiet>;
  readonly inFlight: () => number;
  readonly lastActivityMs: () => number;
  readonly stop: () => void;
}

// Start watching a context's network before navigating. All frames count.
export function watchNetwork(
  context: BrowserContext,
  startedAt: number,
  options: QuietOptions = DEFAULT_QUIET,
): NetworkWatch {
  let inFlight = 0;
  let lastActivity = startedAt;
  let lastRequestAt = startedAt;

  const onRequest = () => {
    inFlight++;
    lastActivity = Date.now();
    lastRequestAt = lastActivity;
  };
  const onDone = () => {
    inFlight = Math.max(0, inFlight - 1);
    lastActivity = Date.now();
  };
  context.on('request', onRequest);
  context.on('requestfinished', onDone);
  context.on('requestfailed', onDone);

  const stop = () => {
    context.off('request', onRequest);
    context.off('requestfinished', onDone);
    context.off('requestfailed', onDone);
  };

  const settle = () =>
    new Promise<NetworkQuiet>((resolve) => {
      const tick = () => {
        const now = Date.now();
        const dwell = now - startedAt;
        const quietFor = now - lastActivity;
        const settled =
          dwell >= options.minDwellMs && inFlight === 0 && quietFor >= options.quietMs;
        if (settled || dwell >= options.maxWaitMs) {
          stop();
          resolve({
            ...options,
            dwellMs: dwell,
            lastRequestAtMs: Math.max(0, lastRequestAt - startedAt),
            settled,
          });
          return;
        }
        setTimeout(tick, 100);
      };
      tick();
    });

  return { settle, inFlight: () => inFlight, lastActivityMs: () => lastActivity, stop };
}
