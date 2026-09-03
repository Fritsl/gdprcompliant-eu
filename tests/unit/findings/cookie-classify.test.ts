import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig, type OutboundFetch } from '@gc/config';
import { COOKIE_CATEGORIES, CookieClassificationSchema, MODEL_CALLS, sha256 } from '@gc/contracts';
import {
  CATEGORY_MAP,
  COOKIE_DATABASE_JOB,
  CookieDatabase,
  CookieDatabaseError,
  DEFAULT_COOKIE_DATABASE_URL,
  DEFAULT_STORE,
  classifyCookie,
  classifyCookies,
  loadCookieDatabase,
  parseCookieDatabase,
  parseCsv,
  refreshCookieDatabase,
} from '@gc/findings';

const db = loadCookieDatabase();

describe('the database (S-06)', () => {
  it('loads the checked-in store with its version', () => {
    expect(db.entries.length).toBeGreaterThan(2_000);
    expect(db.version.source).toBe('Open Cookie Database');
    expect(db.version.licence).toBe('Apache-2.0');
    expect(db.version.version).toBe(
      sha256(readFileSync(join(DEFAULT_STORE, 'open-cookie-database.csv'), 'utf8')),
    );
    expect(db.version.entries).toBe(db.entries.length);
  });

  it('maps every category the database uses onto ours, and refuses one it does not know', () => {
    for (const category of new Set(db.entries.map((e) => e.category))) {
      expect(COOKIE_CATEGORIES).toContain(category);
      expect(category).not.toBe('unknown');
    }
    expect(Object.values(CATEGORY_MAP)).not.toContain('unknown');
    const header =
      'ID,Platform,Category,Cookie / Data Key name,Domain,Description,Retention period,Data Controller,User Privacy & GDPR Rights Portals,Wildcard match';
    expect(() => parseCookieDatabase(`${header}\nx,P,Surveillance,c,,,,,,0\n`)).toThrow(
      /row 2: unknown category "Surveillance"/,
    );
    expect(() => parseCookieDatabase('ID,Name\n1,x\n')).toThrow(CookieDatabaseError);
    expect(() => parseCookieDatabase(`${header}\n`)).toThrow(/no entries/);
  });

  it('parses quoted fields with commas and doubled quotes', () => {
    expect(parseCsv('a,"b, c","d ""e"" f"\n1,2,3\n')).toEqual([
      ['a', 'b, c', 'd "e" f'],
      ['1', '2', '3'],
    ]);
  });
});

describe('classification (S-06)', () => {
  it('a known cookie gets its category, with the source and version recorded', () => {
    const ga = classifyCookie(db, { name: '_ga', domain: 'eksempelbutik.dk' });
    expect(CookieClassificationSchema.safeParse(ga).success).toBe(true);
    expect(ga.category).toBe('analytics');
    expect(ga.resolution).toBe('matched');
    expect(ga.match?.platform).toBe('Google Analytics');
    expect(ga.match?.dataController).toBe('Google');
    expect(ga.source).toEqual({
      name: db.version.source,
      version: db.version.version,
      fetchedAt: db.version.fetchedAt,
    });
  });

  it('an unknown cookie is unknown, never guessed', () => {
    const trk = classifyCookie(db, { name: '_trk', domain: 'eksempelbutik.test' });
    expect(trk).toMatchObject({ category: 'unknown', resolution: 'unmatched', candidates: [] });
    expect(trk.match).toBeUndefined();
    expect(trk.source.version).toBe(db.version.version);
  });

  it('a wildcard entry matches by prefix', () => {
    const measurement = classifyCookie(db, { name: '_ga_ABC123' });
    expect(measurement.resolution).toBe('matched');
    expect(measurement.category).toBe('analytics');
    expect(measurement.match?.wildcard).toBe(true);
  });

  it('entries that disagree make the cookie ambiguous, which is unknown with the candidates shown', () => {
    const version = db.version;
    const small = new CookieDatabase(
      [
        { id: '1', platform: 'A', category: 'analytics', name: 'sid', wildcard: false },
        { id: '2', platform: 'B', category: 'marketing', name: 'sid', wildcard: false },
        { id: '3', platform: 'C', category: 'functional', name: 'lang', wildcard: false },
        {
          id: '4',
          platform: 'D',
          category: 'functional',
          name: 'lang',
          wildcard: false,
          domain: 'shop.test',
        },
      ],
      version,
    );
    const sid = classifyCookie(small, { name: 'sid' });
    expect(sid).toMatchObject({ category: 'unknown', resolution: 'ambiguous' });
    expect(sid.candidates.map((c) => c.platform)).toEqual(['A', 'B']);

    // Agreeing entries are a match; a domain that fits is preferred.
    const lang = classifyCookie(small, { name: 'lang', domain: 'www.shop.test' });
    expect(lang.resolution).toBe('matched');
    expect(lang.match?.platform).toBe('D');
    expect(classifyCookie(small, { name: 'lang', domain: 'other.test' }).match?.platform).toBe('C');
  });

  it('the classification shape cannot carry a category without a match', () => {
    const source = { name: 'x', version: 'a'.repeat(64), fetchedAt: '2026-09-03T00:00:00Z' };
    expect(
      CookieClassificationSchema.safeParse({
        name: 'c',
        category: 'marketing',
        resolution: 'unmatched',
        source,
      }).success,
    ).toBe(false);
    expect(
      CookieClassificationSchema.safeParse({
        name: 'c',
        category: 'unknown',
        resolution: 'matched',
        source,
      }).success,
    ).toBe(false);
  });

  it('classifies a capture’s cookies in one go', () => {
    const results = classifyCookies(db, [
      {
        name: '_ga',
        value: 'x',
        domain: '.shop.dk',
        path: '/',
        expires: -1,
        httpOnly: false,
        secure: false,
        sameSite: 'Lax',
      },
      {
        name: 'zzz_nobody',
        value: 'x',
        domain: 'shop.dk',
        path: '/',
        expires: -1,
        httpOnly: false,
        secure: false,
        sameSite: 'Lax',
      },
    ]);
    expect(results.map((r) => r.category)).toEqual(['analytics', 'unknown']);
  });

  it('the model may suggest for unknowns, in the same vocabulary, but never classifies', () => {
    const output = MODEL_CALLS.classify_cookies.output.safeParse({
      cookies: [
        { name: '_trk', host: 'eksempelbutik.test', category: 'marketing', confidence: 0.4 },
      ],
    });
    expect(output.success).toBe(true);
    expect(
      MODEL_CALLS.classify_cookies.output.safeParse({
        cookies: [{ name: 'x', host: 'a.test', category: 'statistics', confidence: 1 }],
      }).success,
    ).toBe(false);
    expect(classifyCookie(db, { name: '_trk' }).category).toBe('unknown');
  });
});

describe('refresh is a scheduled job (S-06)', () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    APP_BASE_URL: 'https://gdprcompliant.eu',
    DATABASE_URL: 'postgres://gc:gc@localhost:5432/gc',
    MODEL_BASE_URL: 'http://localhost:8000/v1',
    MODEL_CHAT: 'chat',
    MODEL_EMBEDDING: 'embed',
  });

  it('has a schedule and a name for the scheduler, and does nothing at import', () => {
    expect(COOKIE_DATABASE_JOB).toEqual({
      name: 'cookie-database-refresh',
      schedule: '0 4 * * 1',
      description: expect.stringMatching(/EU mirror/),
    });
    expect(
      config.endpoints.find((e) => e.host === new URL(DEFAULT_COOKIE_DATABASE_URL).hostname),
    ).toMatchObject({
      purpose: 'corpus',
    });
  });

  it('fetches through the allowlisted fetch, validates, and replaces the store atomically', async () => {
    const store = mkdtempSync(join(tmpdir(), 'cookies-'));
    const csv = readFileSync(join(DEFAULT_STORE, 'open-cookie-database.csv'), 'utf8');
    const fetch = vi.fn<OutboundFetch>(async (_url, init) => {
      expect(init.purpose).toBe('corpus');
      return new Response(csv, { status: 200, headers: { etag: '"abc123"' } });
    });
    const version = await refreshCookieDatabase({
      fetch,
      store,
      now: () => new Date('2026-09-08T04:00:00Z'),
    });
    expect(fetch).toHaveBeenCalledWith(
      DEFAULT_COOKIE_DATABASE_URL,
      expect.objectContaining({ purpose: 'corpus' }),
    );
    expect(version).toMatchObject({
      source: 'Open Cookie Database',
      licence: 'Apache-2.0',
      version: sha256(csv),
      commit: 'abc123',
      fetchedAt: '2026-09-08T04:00:00.000Z',
      entries: db.entries.length,
    });
    const reloaded = loadCookieDatabase(store);
    expect(reloaded.version).toEqual(version);
    expect(classifyCookie(reloaded, { name: '_ga' }).source.fetchedAt).toBe(
      '2026-09-08T04:00:00.000Z',
    );
  });

  it('a broken or unreachable file leaves the store untouched', async () => {
    const store = mkdtempSync(join(tmpdir(), 'cookies-'));
    const bad = vi.fn<OutboundFetch>(async () => new Response('ID,Nope\n1,2\n', { status: 200 }));
    await expect(refreshCookieDatabase({ fetch: bad, store })).rejects.toThrow(CookieDatabaseError);
    const down = vi.fn<OutboundFetch>(async () => new Response('', { status: 503 }));
    await expect(refreshCookieDatabase({ fetch: down, store })).rejects.toThrow(/HTTP 503/);
    expect(() => loadCookieDatabase(store)).toThrow(/run the refresh job/);
  });
});

describe('edges of the store (S-06)', () => {
  const header =
    'ID,Platform,Category,Cookie / Data Key name,Domain,Description,Retention period,Data Controller,User Privacy & GDPR Rights Portals,Wildcard match';

  it('reads Windows line endings, quoted newlines, a byte-order mark and a missing final newline', () => {
    expect(parseCsv('a,b\r\nc,"d\ne"')).toEqual([
      ['a', 'b'],
      ['c', 'd\ne'],
    ]);
    const entries = parseCookieDatabase(
      `\uFEFF${header}\r\n1,,Functional,x,,,,,,0\r\n\r\n2,P,Marketing,y_,.Shop.TEST,"d, e",1 year,C,https://c.test,1`,
    );
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      id: '1',
      platform: '',
      category: 'functional',
      wildcard: false,
    });
    expect(entries[1]).toMatchObject({
      domain: 'shop.test',
      description: 'd, e',
      retention: '1 year',
      dataController: 'C',
      privacyUrl: 'https://c.test',
      wildcard: true,
    });
  });

  it('a row the schema refuses is named by its line', () => {
    expect(() => parseCookieDatabase(`${header}\n,P,Functional,,,,,,,0\n`)).toThrow(/row 2:/);
  });

  it('a store with only one of its two files is no store', () => {
    const store = mkdtempSync(join(tmpdir(), 'cookies-half-'));
    writeFileSync(join(store, 'open-cookie-database.csv'), `${header}\n1,P,Functional,x,,,,,,0\n`);
    expect(() => loadCookieDatabase(store)).toThrow(/run the refresh job/);
  });

  it('a refresh without an ETag records no commit, and a lookup without a domain sees every entry', async () => {
    const store = mkdtempSync(join(tmpdir(), 'cookies-noetag-'));
    const fetch = vi.fn<OutboundFetch>(
      async () => new Response(`${header}\n1,P,Functional,x,shop.test,,,,,0\n`, { status: 200 }),
    );
    const version = await refreshCookieDatabase({
      fetch,
      store,
      url: 'https://data.gdprcompliant.eu/x.csv',
    });
    expect(version.commit).toBeUndefined();
    expect(version.url).toBe('https://data.gdprcompliant.eu/x.csv');
    const reloaded = loadCookieDatabase(store);
    expect(reloaded.lookup('x')).toHaveLength(1);
    expect(reloaded.lookup('x', 'other.test')).toHaveLength(0);
    expect(classifyCookie(reloaded, { name: 'x', domain: 'other.test' }).resolution).toBe(
      'unmatched',
    );
  });
});
