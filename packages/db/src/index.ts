// @gc/db — Drizzle schema, migrations, and the one way to open the database.
//
//   client    connect(url): explicit connection string, never an environment variable
//   schema    the tables (F-02 lays one; F-03 adds the spine)
//   migrate   apply the committed SQL migrations, idempotently
//   testing   a disposable schema per integration test file

export const PACKAGE = '@gc/db';

export * from './client.js';
export { SHARED_TENANT, TABLES } from './schema.js';
export * from './migrate.js';
export * from './testing.js';
export * from './tenant.js';
export * from './demand.js';
export * from './cases.js';
export * from './timeline.js';
export * from './case-state.js';
export * from './export.js';
export * from './retention.js';
export * from './retention-job.js';
export * from './members.js';
export * from './progress.js';
export * from './evidence-pack.js';
export * from './findings.js';
