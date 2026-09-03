import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256, type CookieDatabaseVersion, CookieDatabaseVersionSchema } from '@gc/contracts';
import type { OutboundFetch } from '@gc/config';
import {
  CookieDatabaseError,
  DATABASE_FILE,
  DEFAULT_STORE,
  VERSION_FILE,
  parseCookieDatabase,
} from './database.js';

// The database is refreshed by a scheduled job, not baked in at build time. The job
// fetches the file through the allowlisted, recorded fetch, validates it in full, and
// only then replaces the store — atomically, so a reader never sees half a file.
//
// The source is an EU mirror: the upstream repository lives on GitHub, which is outside
// the EEA, and the system does not send requests there. The mirror is refreshed by ops.

export const COOKIE_DATABASE_SOURCE = 'Open Cookie Database';
export const COOKIE_DATABASE_LICENCE = 'Apache-2.0';
export const DEFAULT_COOKIE_DATABASE_URL = 'https://data.gdprcompliant.eu/open-cookie-database.csv';

// For the scheduler (F-06): weekly, Monday 04:00 UTC.
export const COOKIE_DATABASE_JOB = {
  name: 'cookie-database-refresh',
  schedule: '0 4 * * 1',
  description: 'Fetch the Open Cookie Database from the EU mirror and replace the runtime store.',
} as const;

export interface RefreshOptions {
  readonly fetch: OutboundFetch;
  readonly url?: string;
  readonly store?: string;
  readonly now?: () => Date;
}

export async function refreshCookieDatabase(
  options: RefreshOptions,
): Promise<CookieDatabaseVersion> {
  const url = options.url ?? DEFAULT_COOKIE_DATABASE_URL;
  const store = options.store ?? DEFAULT_STORE;
  const response = await options.fetch(url, { purpose: 'corpus', method: 'GET' });
  if (!response.ok)
    throw new CookieDatabaseError(`refresh: ${url} answered HTTP ${response.status}`);
  const csv = await response.text();
  const entries = parseCookieDatabase(csv);

  const version = CookieDatabaseVersionSchema.parse({
    source: COOKIE_DATABASE_SOURCE,
    url,
    licence: COOKIE_DATABASE_LICENCE,
    version: sha256(csv),
    ...(response.headers.get('etag')
      ? { commit: response.headers.get('etag')!.replace(/"/g, '') }
      : {}),
    fetchedAt: (options.now ?? (() => new Date()))().toISOString(),
    entries: entries.length,
  });

  mkdirSync(store, { recursive: true });
  const csvTmp = join(store, `${DATABASE_FILE}.tmp`);
  const versionTmp = join(store, `${VERSION_FILE}.tmp`);
  writeFileSync(csvTmp, csv);
  writeFileSync(versionTmp, `${JSON.stringify(version, null, 2)}\n`);
  renameSync(csvTmp, join(store, DATABASE_FILE));
  renameSync(versionTmp, join(store, VERSION_FILE));
  return version;
}
