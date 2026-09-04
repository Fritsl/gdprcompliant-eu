import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig, type FetchLike } from '@gc/config';
import type { Company } from '@gc/contracts';
import {
  REGISTRY_ADAPTERS,
  RegistryUnavailable,
  adapterFor,
  companyFromRegistry,
  createCvrAdapter,
  createOffeneRegisterAdapter,
  registryLookup,
  type RegistryAdapter,
} from '@gc/scanner';

// Business registry adapters (D-03): one interface, one file per country, one contract
// suite over every adapter. Each documents its register's terms and keeps its pace;
// each answers with what the register said and `unknown` for what it did not; each
// records and replays through the one recorded fetch, so CI never reaches a register.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const T0 = new Date('2026-09-04T09:14:00Z');
const NOW = () => T0;
const endpoints = JSON.parse(
  readFileSync(join(ROOT, 'packages', 'config', 'endpoints.json'), 'utf8'),
) as {
  host: string;
  purpose: string;
  jurisdiction: string;
}[];

const env = {
  NODE_ENV: 'test',
  APP_BASE_URL: 'https://gdprcompliant.eu',
  DATABASE_URL: 'postgres://gc:gc@localhost:5432/gc',
  MODEL_BASE_URL: 'https://llm.example.eu/v1',
  MODEL_API_KEY: 'sk-test',
  MODEL_CHAT: 'chat-model',
  MODEL_EMBEDDING: 'embed-model',
};
const configIn = (mode: 'record' | 'replay') =>
  loadConfig(
    { ...env, GC_NETWORK: mode },
    { endpoints: [...endpoints, { host: 'llm.example.eu', purpose: 'model', jurisdiction: 'DK' }] },
  );

// A stand-in for each register, answering in its documented response shape. Only the
// known entity answers; anything else is an empty result.
const KNOWN = { cvr: '12345678', offeneregister: 'K1101R_HRB12345' } as const;

const cvrHit = {
  hits: {
    hits: [
      {
        _source: {
          Vrvirksomhed: {
            cvrNummer: 12345678,
            hjemmeside: [{ hjemmeside: 'eksempelbutik.dk' }],
            virksomhedMetadata: {
              nyesteNavn: { navn: 'Eksempelbutik ApS' },
              sammensatStatus: 'NORMAL',
              nyesteHovedbranche: {
                branchekode: '479110',
                branchetekst: 'Detailhandel med dagligvarer via internet',
              },
              nyesteAntalAnsatte: { intervalKodeAntalAnsatte: 'ANTAL_10_19' },
              nyesteBeliggenhedsadresse: {
                vejnavn: 'Testvej',
                husnummerFra: '1',
                postnummer: 2100,
                postdistrikt: 'København Ø',
              },
            },
          },
        },
      },
    ],
  },
};
const cvrHitWithoutHeadcount = JSON.parse(JSON.stringify(cvrHit)) as typeof cvrHit;
delete (
  cvrHitWithoutHeadcount.hits.hits[0]!._source.Vrvirksomhed.virksomhedMetadata as {
    nyesteAntalAnsatte?: unknown;
  }
).nyesteAntalAnsatte;

const offeneHit = {
  columns: [
    'native_company_number',
    'name',
    'current_status',
    'registered_address',
    'registrar',
    'federal_state',
  ],
  rows: [
    [
      'K1101R_HRB12345',
      'Beispielshop GmbH',
      'currently registered',
      'Musterstraße 1, 10115 Berlin',
      'Berlin (Charlottenburg)',
      'Berlin',
    ],
  ],
};

function standIn(): FetchLike {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (u.hostname === 'distribution.virk.dk') {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        query: { bool: { must: Record<string, Record<string, unknown>>[] } };
      };
      const must = body.query.bool.must[0]!;
      const term = must['term']?.['Vrvirksomhed.cvrNummer'];
      const name =
        (must['match']?.['Vrvirksomhed.virksomhedMetadata.nyesteNavn.navn'] as
          string | undefined) ?? '';
      const domain =
        (must['match']?.['Vrvirksomhed.hjemmeside.hjemmeside'] as string | undefined) ?? '';
      if (term === 12345678 || domain === 'eksempelbutik.dk') return json(cvrHit);
      if (term === 87654321) return json(cvrHitWithoutHeadcount);
      if (/eksempelbutik/i.test(name)) return json(cvrHit);
      return json({ hits: { hits: [] } });
    }
    if (u.hostname === 'db.offeneregister.de') {
      const v = u.searchParams.get('v') ?? '';
      if (v === KNOWN.offeneregister || /beispielshop/i.test(v)) return json(offeneHit);
      return json({ ...offeneHit, rows: [] });
    }
    return new Response('not found', { status: 404 });
  });
}

const credentials = { CVR_USER: 'gc', CVR_PASSWORD: 'secret' };
const company: Company = { domain: 'eksempelbutik.dk', country: 'DK', locale: 'da' };

describe('the adapters, one file each behind one door', () => {
  it('cover DK and DE, and a third country needs nothing outside its own file', () => {
    expect(REGISTRY_ADAPTERS.map((a) => [a.id, a.country])).toEqual([
      ['cvr', 'DK'],
      ['offeneregister', 'DE'],
    ]);
    expect(adapterFor('DK')?.id).toBe('cvr');
    expect(adapterFor('DE')?.id).toBe('offeneregister');
    expect(adapterFor('SE')).toBeUndefined();
    const dir = join(ROOT, 'packages', 'scanner', 'src', 'registries');
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
    expect(files.sort()).toEqual(['cvr.ts', 'index.ts', 'offeneregister.ts', 'types.ts']);
    for (const f of ['cvr.ts', 'offeneregister.ts']) {
      const imports = [...readFileSync(join(dir, f), 'utf8').matchAll(/from '([^']+)'/g)].map(
        (m) => m[1],
      );
      expect(imports, f).toEqual(['./types.js']);
    }
    const index = readFileSync(join(dir, 'index.ts'), 'utf8');
    expect(index).toContain("from './cvr.js'");
    expect(index).toContain("from './offeneregister.js'");
  });

  it.each(REGISTRY_ADAPTERS.map((a) => [a.id, a] as const))(
    '%s documents its terms and pace, and its host is declared in the EEA',
    (_, a) => {
      expect(a.terms.url).toMatch(/^https:\/\//);
      expect(a.terms.licence.length).toBeGreaterThan(20);
      expect(a.terms.minIntervalMs).toBeGreaterThanOrEqual(500);
      expect(a.searches.length).toBeGreaterThan(0);
      const declared = endpoints.find((e) => e.host === a.host);
      expect(declared, a.host).toBeDefined();
      expect(declared!.purpose).toBe('registry');
      expect(['DK', 'DE', 'EU']).toContain(declared!.jurisdiction);
      const readme = readFileSync(
        join(ROOT, 'packages', 'scanner', 'src', 'registries', 'README.md'),
        'utf8',
      );
      expect(readme).toContain(`\`${a.id}\``);
      expect(readme).toContain(a.host);
    },
  );
});

// The contract every adapter is held to, identically.
describe.each(REGISTRY_ADAPTERS.map((a) => [a.id, a] as const))(
  'the contract, on %s',
  (id, adapter: RegistryAdapter) => {
    const cassettes = mkdtempSync(join(tmpdir(), `registry-${id}-`));
    const known = KNOWN[id as keyof typeof KNOWN];

    it('records the register’s answer through the door, then replays it with the network pulled', async () => {
      const upstream = standIn();
      const recorded = await registryLookup(
        configIn('record'),
        adapter,
        { registryId: known },
        {
          cassettesDir: cassettes,
          impl: upstream,
          now: NOW,
          credentials,
        },
      );
      expect(recorded).toBeDefined();
      expect(recorded).toMatchObject({ registry: id, registryId: known, country: adapter.country });
      expect(recorded!.legalName.length).toBeGreaterThan(3);
      expect(['active', 'ceased', 'unknown']).toContain(recorded!.status);
      expect(recorded!.source.host).toBe(adapter.host);
      expect(recorded!.source.fetchedAt).toBe(T0.toISOString());
      expect(readdirSync(join(cassettes, `registry-${id}`))).toHaveLength(1);

      const pulled = vi.fn<FetchLike>(async () => {
        throw new Error('the network cable is pulled');
      });
      const replayed = await registryLookup(
        configIn('replay'),
        adapter,
        { registryId: known },
        {
          cassettesDir: cassettes,
          impl: pulled,
          now: NOW,
          credentials,
        },
      );
      expect(replayed).toEqual(recorded);
      expect(pulled).not.toHaveBeenCalled();
      // The cassette holds no credential.
      const file = readdirSync(join(cassettes, `registry-${id}`))[0]!;
      const text = readFileSync(join(cassettes, `registry-${id}`, file), 'utf8');
      expect(text).not.toContain('secret');
      expect(text).not.toMatch(/Basic [A-Za-z0-9+/=]{8,}/);
    });

    it('answers nothing for an entity the register does not have, never a guess', async () => {
      const none = await registryLookup(
        configIn('record'),
        adapter,
        { registryId: '00000000' },
        {
          cassettesDir: cassettes,
          impl: standIn(),
          now: NOW,
          credentials,
        },
      );
      expect(none).toBeUndefined();
    });

    it('gives the headcount as the register bands it, or unknown, never a number', async () => {
      const entity = (await registryLookup(
        configIn('record'),
        adapter,
        { registryId: known },
        {
          cassettesDir: cassettes,
          impl: standIn(),
          now: NOW,
          credentials,
        },
      ))!;
      expect(typeof entity.headcountBand).toBe('string');
      expect(
        entity.headcountBand === 'unknown' || /^\d+(–\d+|\+)$/.test(entity.headcountBand),
      ).toBe(true);
      const merged = companyFromRegistry(company, entity);
      expect(merged.legalName).toBe(entity.legalName);
      expect(merged.registryId).toBe(known);
      if (entity.headcountBand === 'unknown') expect(merged.headcountBand).toBeUndefined();
      else expect(merged.headcountBand).toBe(entity.headcountBand);
      expect(entity.group).toEqual({});
    });

    it('keeps the register’s pace whatever the caller does', async () => {
      const fast =
        id === 'cvr'
          ? createCvrAdapter({ minIntervalMs: 150 })
          : createOffeneRegisterAdapter({ minIntervalMs: 150 });
      const started = Date.now();
      const upstream = standIn();
      await Promise.all([
        registryLookup(
          configIn('record'),
          fast,
          { registryId: known },
          { cassettesDir: cassettes, impl: upstream, now: NOW, credentials },
        ),
        registryLookup(
          configIn('record'),
          fast,
          { registryId: known },
          { cassettesDir: cassettes, impl: upstream, now: NOW, credentials },
        ),
        registryLookup(
          configIn('record'),
          fast,
          { registryId: known },
          { cassettesDir: cassettes, impl: upstream, now: NOW, credentials },
        ),
      ]);
      expect(Date.now() - started).toBeGreaterThanOrEqual(280);
    });
  },
);

describe('what each register can and cannot say', () => {
  const cassettes = mkdtempSync(join(tmpdir(), 'registry-specifics-'));

  it('cvr reads the band, the sector and the address, needs credentials, and searches by domain and name', async () => {
    const cvr = adapterFor('DK')!;
    const byId = (await registryLookup(
      configIn('record'),
      cvr,
      { registryId: '12345678' },
      { cassettesDir: cassettes, impl: standIn(), now: NOW, credentials },
    ))!;
    expect(byId).toMatchObject({
      legalName: 'Eksempelbutik ApS',
      status: 'active',
      headcountBand: '10–19',
      sector: { code: '479110', label: 'Detailhandel med dagligvarer via internet' },
      address: 'Testvej 1, 2100 København Ø',
    });
    const noBand = (await registryLookup(
      configIn('record'),
      cvr,
      { registryId: '87654321' },
      { cassettesDir: cassettes, impl: standIn(), now: NOW, credentials },
    ))!;
    expect(noBand.headcountBand).toBe('unknown');
    const byDomain = await registryLookup(
      configIn('record'),
      cvr,
      { domain: 'eksempelbutik.dk' },
      { cassettesDir: cassettes, impl: standIn(), now: NOW, credentials },
    );
    expect(byDomain?.registryId).toBe('12345678');
    const byName = await registryLookup(
      configIn('record'),
      cvr,
      { name: 'Eksempelbutik' },
      { cassettesDir: cassettes, impl: standIn(), now: NOW, credentials },
    );
    expect(byName?.registryId).toBe('12345678');
    await expect(
      registryLookup(
        configIn('record'),
        cvr,
        { registryId: '12345678' },
        { cassettesDir: cassettes, impl: standIn(), now: NOW },
      ),
    ).rejects.toThrow(RegistryUnavailable);
  });

  it('offeneregister reads the name, status and seat, knows no headcount and no sector, and searches by name', async () => {
    const de = adapterFor('DE')!;
    const byName = await registryLookup(
      configIn('record'),
      de,
      { name: 'Beispielshop' },
      { cassettesDir: cassettes, impl: standIn(), now: NOW },
    );
    expect(byName).toMatchObject({
      registryId: 'K1101R_HRB12345',
      legalName: 'Beispielshop GmbH',
      status: 'active',
      address: 'Musterstraße 1, 10115 Berlin',
      headcountBand: 'unknown',
    });
    expect(byName!.sector).toBeUndefined();
    expect(de.searches).not.toContain('domain');
    expect(
      await registryLookup(
        configIn('record'),
        de,
        { domain: 'beispielshop.de' },
        { cassettesDir: cassettes, impl: standIn(), now: NOW },
      ),
    ).toBeUndefined();
    expect(de.terms.attribution).toContain('OffeneRegister.de');
  });

  it('a host the allowlist does not declare is refused before any bytes leave', async () => {
    const rogue: RegistryAdapter = {
      ...adapterFor('DK')!,
      id: 'rogue',
      host: 'registry.example.com',
      async lookup(_q, ctx) {
        await ctx.fetch('https://registry.example.com/x', { purpose: 'registry' });
        return undefined;
      },
    };
    const upstream = standIn();
    await expect(
      registryLookup(
        configIn('record'),
        rogue,
        { registryId: '1' },
        { cassettesDir: cassettes, impl: upstream, now: NOW },
      ),
    ).rejects.toThrow(/not declared|allowlist|refused/i);
    expect(upstream).not.toHaveBeenCalled();
  });
});
