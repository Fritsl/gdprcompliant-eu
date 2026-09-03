// @gc/scanner — the Playwright pool, the three passes, the collectors.
//
//   fixtures   the fixture estate: local hosts served through the browser proxy, and
//              the expected.json each one is measured against (F-07)
//   pool       BrowserPool: a fresh context per pass, limits, deadlines, a kill switch (S-01)

export const PACKAGE = '@gc/scanner';

export * from './fixtures/index.js';
export * from './pool.js';
