// @gc/worker — the process that runs scans and the scheduled jobs. The web app only
// enqueues; everything that needs a browser or a clock lives here.

export const PACKAGE = '@gc/worker';

export * from './scan.js';
