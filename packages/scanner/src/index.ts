// @gc/scanner — the Playwright pool, the three passes, the collectors.
//
//   fixtures   the fixture estate: local hosts served through the browser proxy, and
//              the expected.json each one is measured against (F-07)
//   pool       BrowserPool: a fresh context per pass, limits, deadlines, a kill switch (S-01)
//   passes     Pass A: load, wait for network quiet, touch nothing (S-02)
//   evidence   a capture as content-addressed evidence rows
//   checks     the security surface a stranger can see (S-12)
//   discovery  where the policies are, across languages and pages (S-09)

export const PACKAGE = '@gc/scanner';

export * from './fixtures/index.js';
export * from './pool.js';
export * from './egress.js';
export * from './passes/network-quiet.js';
export * from './passes/pass-a.js';
export * from './passes/pass-bc.js';
export * from './passes/differ.js';
export * from './scan.js';
export { hostOf as hostOfUrl } from './passes/instrument.js';
export * from './evidence.js';
export * from './checks/index.js';
export * from './discovery/index.js';
export * from './dns/index.js';
export * from './vendors/index.js';
export * from './transfers/index.js';
export * from './ct/index.js';
export * from './consent/index.js';
