import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CookieDatabaseVersionSchema,
  CookieEntrySchema,
  type CookieCategory,
  type CookieDatabaseVersion,
  type CookieEntry,
} from '@gc/contracts';

// The cookie database as a runtime store: a CSV and a version.json in one directory,
// replaced by the refresh job (refresh.ts) and read here. The checked-in copy is the
// first version, not the truth; the job's copy is.

export const DEFAULT_STORE = fileURLToPath(new URL('../../data/cookies/', import.meta.url));
export const DATABASE_FILE = 'open-cookie-database.csv';
export const VERSION_FILE = 'version.json';

// The Open Cookie Database's columns, in order. A file with other columns is refused.
export const EXPECTED_HEADER = [
  'ID',
  'Platform',
  'Category',
  'Cookie / Data Key name',
  'Domain',
  'Description',
  'Retention period',
  'Data Controller',
  'User Privacy & GDPR Rights Portals',
  'Wildcard match',
] as const;

// The database's categories, mapped to ours. A category not listed here fails the load:
// a new one is a deliberate decision, not a silent bucket.
export const CATEGORY_MAP: Record<string, Exclude<CookieCategory, 'unknown'>> = {
  Necessary: 'necessary',
  Functional: 'functional',
  Analytics: 'analytics',
  Marketing: 'marketing',
  Personalization: 'personalisation',
  Security: 'security',
};

export class CookieDatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CookieDatabaseError';
  }
}

// RFC 4180: fields may be quoted, quotes doubled inside, newlines allowed inside quotes.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function parseCookieDatabase(csv: string): CookieEntry[] {
  const rows = parseCsv(csv.replace(/^\uFEFF/, ''));
  const header = rows[0] ?? [];
  if (header.join('|') !== EXPECTED_HEADER.join('|')) {
    throw new CookieDatabaseError(`unexpected columns: ${header.join(', ')}`);
  }
  const entries: CookieEntry[] = [];
  rows.slice(1).forEach((cells, i) => {
    if (cells.length === 1 && cells[0] === '') return;
    const [
      id,
      platform,
      category,
      name,
      domain,
      description,
      retention,
      controller,
      privacyUrl,
      wildcard,
    ] = cells;
    const mapped = CATEGORY_MAP[category ?? ''];
    if (!mapped) throw new CookieDatabaseError(`row ${i + 2}: unknown category "${category}"`);
    const parsed = CookieEntrySchema.safeParse({
      id,
      platform: platform ?? '',
      category: mapped,
      name,
      wildcard: wildcard === '1',
      ...(domain ? { domain: domain.replace(/^\./, '').toLowerCase() } : {}),
      ...(description ? { description } : {}),
      ...(retention ? { retention } : {}),
      ...(controller ? { dataController: controller } : {}),
      ...(privacyUrl ? { privacyUrl } : {}),
    });
    if (!parsed.success) {
      throw new CookieDatabaseError(
        `row ${i + 2}: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
      );
    }
    entries.push(parsed.data);
  });
  if (entries.length === 0) throw new CookieDatabaseError('the database has no entries');
  return entries;
}

export class CookieDatabase {
  private readonly exact = new Map<string, CookieEntry[]>();
  private readonly prefixes: CookieEntry[] = [];

  constructor(
    readonly entries: readonly CookieEntry[],
    readonly version: CookieDatabaseVersion,
  ) {
    for (const e of entries) {
      if (e.wildcard) this.prefixes.push(e);
      else this.exact.set(e.name, [...(this.exact.get(e.name) ?? []), e]);
    }
  }

  // Every entry that could describe this cookie: exact names first, then prefixes.
  lookup(name: string, domain?: string): CookieEntry[] {
    const found = [
      ...(this.exact.get(name) ?? []),
      ...this.prefixes.filter((e) => name.startsWith(e.name)),
    ];
    if (domain === undefined) return found;
    // Entries that name a domain must match it; entries without one apply anywhere.
    const d = domain.replace(/^\./, '').toLowerCase();
    const byDomain = found.filter(
      (e) => e.domain !== undefined && (d === e.domain || d.endsWith(`.${e.domain}`)),
    );
    return byDomain.length > 0 ? byDomain : found.filter((e) => e.domain === undefined);
  }
}

export function loadCookieDatabase(store: string = DEFAULT_STORE): CookieDatabase {
  const csvPath = join(store, DATABASE_FILE);
  const versionPath = join(store, VERSION_FILE);
  if (!existsSync(csvPath) || !existsSync(versionPath)) {
    throw new CookieDatabaseError(`no cookie database at ${store}; run the refresh job`);
  }
  const csv = readFileSync(csvPath, 'utf8');
  const version = CookieDatabaseVersionSchema.parse(JSON.parse(readFileSync(versionPath, 'utf8')));
  return new CookieDatabase(parseCookieDatabase(csv), version);
}
