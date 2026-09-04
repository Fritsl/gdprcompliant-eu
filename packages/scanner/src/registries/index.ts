import type { Config } from '@gc/config';
import { createRecordedFetch } from '@gc/config';
import type { Company, CountryCode } from '@gc/contracts';
import { createCvrAdapter } from './cvr.js';
import { createOffeneRegisterAdapter } from './offeneregister.js';
import type { LookupContext, RegistryAdapter, RegistryEntity, RegistryQuery } from './types.js';

// The adapters (D-03), one per country, behind one door. A third country is one more
// file and one more line here; nothing else changes. Every call goes through the
// recorded fetch, so tests replay cassettes and CI never reaches a register.

export * from './types.js';
export * from './cvr.js';
export * from './offeneregister.js';

export const REGISTRY_ADAPTERS: readonly RegistryAdapter[] = [
  createCvrAdapter(),
  createOffeneRegisterAdapter(),
];

export const adapterFor = (country: CountryCode): RegistryAdapter | undefined =>
  REGISTRY_ADAPTERS.find((a) => a.country === country);

export const adapterById = (id: string): RegistryAdapter | undefined =>
  REGISTRY_ADAPTERS.find((a) => a.id === id);

export interface RegistryLookupOptions {
  readonly now?: () => Date;
  readonly credentials?: Readonly<Record<string, string>>;
  // The cassette namespace prefix; tests point it at their own directory.
  readonly cassettesDir?: string;
  readonly impl?: Parameters<typeof createRecordedFetch>[1]['impl'];
}

// One lookup by register id, through the recorded fetch for that adapter.
export async function registryLookup(
  config: Config,
  adapter: RegistryAdapter,
  query: RegistryQuery,
  options: RegistryLookupOptions = {},
): Promise<RegistryEntity | undefined> {
  const fetch = createRecordedFetch(config, {
    name: `registry-${adapter.id}`,
    ...(options.cassettesDir ? { dir: options.cassettesDir } : {}),
    ...(options.impl ? { impl: options.impl } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  const ctx: LookupContext = {
    fetch,
    ...(options.now ? { now: options.now } : {}),
    ...(options.credentials ? { credentials: options.credentials } : {}),
  };
  return adapter.lookup(query, ctx);
}

// What the register settles about the company: only what it said, nothing inferred.
export function companyFromRegistry(company: Company, entity: RegistryEntity): Company {
  return {
    ...company,
    legalName: entity.legalName,
    registry: entity.registry,
    registryId: entity.registryId,
    ...(entity.sector ? { sector: entity.sector.label, sectorCode: entity.sector.code } : {}),
    ...(entity.headcountBand !== 'unknown' ? { headcountBand: entity.headcountBand } : {}),
  };
}
