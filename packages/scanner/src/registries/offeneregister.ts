import {
  paced,
  RegistryUnavailable,
  type RegistryAdapter,
  type RegistryEntity,
  type RegistryQuery,
} from './types.js';

// Germany: the Handelsregister, read through OffeneRegister.de, the Open Knowledge
// Foundation Deutschland's open copy of the register. Terms: the data is published under
// the Open Database Licence (ODbL 1.0); the site asks for attribution and for polite
// use of its query API. No credentials. Pace: at most one query every two seconds, the
// pace the project asks of automated clients.
//
// What the copy carries: the entity's name, court and register number, its seat and
// status, and, where the register filed one, the object of the company. It carries no
// headcount and no sector code, so those are unknown from this source; the parent is
// unknown too, because ownership is not a Handelsregister entry.

export const OFFENEREGISTER_HOST = 'db.offeneregister.de';
const QUERY = `https://${OFFENEREGISTER_HOST}/openregister.json`;

export function createOffeneRegisterAdapter(
  options: { minIntervalMs?: number } = {},
): RegistryAdapter {
  const pace = paced(options.minIntervalMs ?? 2_000);
  return {
    id: 'offeneregister',
    country: 'DE',
    name: 'Handelsregister (via OffeneRegister.de)',
    host: OFFENEREGISTER_HOST,
    terms: {
      url: 'https://offeneregister.de/faq/',
      licence: 'Open Database Licence (ODbL) 1.0, from the Open Knowledge Foundation Deutschland.',
      attribution: 'Datenquelle: OffeneRegister.de (OKF Deutschland), ODbL 1.0',
      minIntervalMs: options.minIntervalMs ?? 2_000,
      credentials: false,
    },
    searches: ['registryId', 'name'],
    async lookup(query: RegistryQuery, ctx): Promise<RegistryEntity | undefined> {
      const where = query.registryId
        ? `native_company_number = :v`
        : query.name
          ? `name like :v`
          : undefined;
      if (!where) return undefined;
      const value = query.registryId ?? `%${query.name}%`;
      const sql = `select native_company_number, name, current_status, registered_address, registrar, federal_state from company where ${where} limit 1`;
      const url = `${QUERY}?sql=${encodeURIComponent(sql)}&v=${encodeURIComponent(value)}`;
      const response = await pace(() =>
        ctx.fetch(url, {
          purpose: 'registry',
          method: 'GET',
          headers: { accept: 'application/json' },
        }),
      );
      if (response.status === 429)
        throw new RegistryUnavailable(
          'offeneregister',
          'the register asked for a slower pace (429)',
        );
      if (!response.ok) throw new RegistryUnavailable('offeneregister', `HTTP ${response.status}`);
      const json = (await response.json()) as { columns?: string[]; rows?: unknown[][] };
      const row = json.rows?.[0];
      if (!row || !json.columns) return undefined;
      const record: Record<string, unknown> = {};
      json.columns.forEach((c, i) => {
        record[c] = row[i];
      });
      const legalName = record['name'];
      const number = record['native_company_number'];
      if (typeof legalName !== 'string' || typeof number !== 'string') return undefined;
      const status = record['current_status'];
      const address = record['registered_address'];
      return {
        registry: 'offeneregister',
        registryId: number,
        legalName,
        country: 'DE',
        status:
          typeof status === 'string' && /currently registered|aktiv/i.test(status)
            ? 'active'
            : typeof status === 'string' && /deleted|gelöscht|liquidation/i.test(status)
              ? 'ceased'
              : 'unknown',
        ...(typeof address === 'string' && address ? { address } : {}),
        headcountBand: 'unknown',
        group: {},
        source: {
          url,
          host: OFFENEREGISTER_HOST,
          fetchedAt: (ctx.now ?? (() => new Date()))().toISOString(),
        },
        record,
      };
    },
  };
}
