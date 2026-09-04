import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signalsFromDocument } from '@gc/contracts';
import {
  UnsupportedTarget,
  caseLocale,
  caseTimeline,
  createTestDatabase,
  openCase,
  openCaseForTarget,
  overrideCaseLocale,
  testDatabaseUrl,
  withTenant,
  type TestDatabase,
} from '@gc/db';
import { BrowserPool, FixtureServer, collectPassA, loadFixtureSites } from '@gc/scanner';

// Locale from the target, not the visitor (I-03): Pass A reads what the site says it
// speaks; the case opens in the target's jurisdiction and language with a number in the
// target's country; the visitor may change the language of their own case and the change
// is kept; a target the product cannot place is refused with what was tried.

const url = (() => {
  try {
    return testDatabaseUrl();
  } catch (e) {
    if (process.env['CI']) throw e;
    console.warn((e as Error).message);
    return undefined;
  }
})();

const T0 = new Date('2026-09-04T09:14:00Z');
const sites = loadFixtureSites();
let server: FixtureServer;
let pool: BrowserPool;
let db: TestDatabase;

beforeAll(async () => {
  server = await new FixtureServer(sites.flatMap((s) => s.hosts)).start();
  pool = await new BrowserPool({
    concurrency: 2,
    passTimeoutMs: 60_000,
    navigationTimeoutMs: 10_000,
    launch: { proxy: { server: server.proxy } },
    ignoreHTTPSErrors: true,
  }).start();
  if (url) db = await createTestDatabase(url);
});

afterAll(async () => {
  await pool?.stop();
  await server?.stop();
  await db?.drop();
});

const capture = async (host: string) =>
  (await collectPassA(pool, { url: `https://${host}/` }, { quiet: { minDwellMs: 500 } })).capture;

describe('the target decides', () => {
  it('Pass A reads the document language and title', async () => {
    const c = await capture('injected.shop.test');
    expect(c.document?.lang).toBe('da');
    expect(c.document?.title).toBe('Injected Shop');
    const e = await capture('exfil.attacker.test');
    expect(e.document?.lang).toBe('en');
  });

  it.skipIf(!url)(
    'a Danish-language site opens a Danish case with a DK number, whoever scans',
    async () => {
      const c = await capture('injected.shop.test');
      const opened = await openCaseForTarget(db, {
        signals: signalsFromDocument('injected.shop.test', c.document),
        now: () => T0,
      });
      expect(opened.target).toEqual({
        jurisdiction: 'DK',
        locale: 'da',
        basis: 'language',
        signal: 'da',
      });
      expect(opened.caseId.startsWith('DK-26-')).toBe(true);
      expect(await caseLocale(db, opened.tenantId, opened.caseId)).toBe('da');
    },
  );

  it.skipIf(!url)(
    'an English site on a neutral domain is placed by its register entry',
    async () => {
      const c = await capture('exfil.attacker.test');
      const opened = await openCaseForTarget(db, {
        signals: signalsFromDocument('exfil.attacker.test', c.document, 'DE'),
        now: () => T0,
      });
      expect(opened.target).toMatchObject({ jurisdiction: 'DE', locale: 'de', basis: 'registry' });
      expect(opened.caseId.startsWith('DE-26-')).toBe(true);
      expect(await caseLocale(db, opened.tenantId, opened.caseId)).toBe('de');
    },
  );

  it.skipIf(!url)(
    'the visitor can change the language of their case, and it stays changed',
    async () => {
      const opened = await openCaseForTarget(db, {
        signals: { domain: 'butik.dk', documentLang: 'da' },
        now: () => T0,
      });
      const person = { kind: 'person' as const, userId: 'u-1', name: 'Mette' };
      const change = await overrideCaseLocale(db, opened.tenantId, opened.caseId, 'en', person, T0);
      expect(change).toEqual({ from: 'da', to: 'en', changed: true });
      expect(await caseLocale(db, opened.tenantId, opened.caseId)).toBe('en');
      const again = await overrideCaseLocale(db, opened.tenantId, opened.caseId, 'en', person, T0);
      expect(again.changed).toBe(false);

      const timeline = await withTenant(db, opened.tenantId, (tx) =>
        caseTimeline(tx, opened.caseId),
      );
      const events = timeline.filter((e) => e.type === 'locale_overridden');
      expect(events).toHaveLength(1);
      expect(events[0]!.payload).toEqual({ from: 'da', to: 'en' });
      expect(events[0]!.actor).toEqual(person);

      // The same owner scanning the same domain again continues the case, in the language
      // they chose; the jurisdiction is still the target's.
      const continued = await openCase(db, {
        company: { domain: 'butik.dk', country: 'DK', locale: 'da' },
        jurisdiction: 'DK',
        locale: 'da',
        tenantId: opened.tenantId,
        now: () => new Date(T0.getTime() + 60_000),
      });
      expect(continued.continued).toBe(true);
      expect(continued.caseId).toBe(opened.caseId);
      expect(await caseLocale(db, opened.tenantId, opened.caseId)).toBe('en');
    },
  );

  it.skipIf(!url)('a target the product cannot place is refused with what was tried', async () => {
    const attempt = openCaseForTarget(db, {
      signals: { domain: 'boutique.fr', documentLang: 'fr', registryCountry: 'FR' },
      now: () => T0,
    });
    await expect(attempt).rejects.toThrow(UnsupportedTarget);
    await expect(attempt).rejects.toThrow(
      'cannot open a case for this target: language fr: not a supported jurisdiction; tld .fr: no country; registry FR: not supported — the product speaks DK, DE',
    );
  });
});
