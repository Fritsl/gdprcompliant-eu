import {
  paced,
  RegistryUnavailable,
  type RegistryAdapter,
  type RegistryEntity,
  type RegistryQuery,
} from './types.js';

// Denmark: Det Centrale Virksomhedsregister, through Erhvervsstyrelsen's system-to-system
// interface (CVR-data via Elasticsearch). Terms: access is under an agreement with
// Erhvervsstyrelsen ("Vilkår for brug af CVR-data via system-til-system-adgang"); the data
// itself is public register data. The interface is queried with credentials the
// deployment holds; without them the adapter says the register is unavailable rather
// than trying anonymously. Pace: at most one query per second per deployment, which is
// well inside what the agreement allows and what a small company's case needs.
//
// What the register carries: the entity's name, CVR number, address, status, the
// industry code (branchekode, DB07) and the employee band as Erhvervsstyrelsen bands it
// (antalAnsatte intervals such as "10-19"). What it does not carry is left unknown.

export const CVR_HOST = 'distribution.virk.dk';
const SEARCH = `https://${CVR_HOST}/cvr-permanent/virksomhed/_search`;

const bandOf = (record: Record<string, unknown>): string | 'unknown' => {
  const meta = (record['virksomhedMetadata'] as Record<string, unknown> | undefined) ?? {};
  const employees = (meta['nyesteAntalAnsatte'] as Record<string, unknown> | undefined) ?? {};
  const band = employees['intervalKodeAntalAnsatte'];
  if (typeof band !== 'string' || band.length === 0) return 'unknown';
  // "ANTAL_10_19" as the register codes it, read as "10–19".
  const m = /^ANTAL_(\d+)_(\d+|MAX)$/.exec(band);
  if (!m) return 'unknown';
  return m[2] === 'MAX' ? `${m[1]}+` : `${m[1]}–${m[2]}`;
};

const nameOf = (record: Record<string, unknown>): string | undefined => {
  const meta = (record['virksomhedMetadata'] as Record<string, unknown> | undefined) ?? {};
  const latest = meta['nyesteNavn'] as { navn?: string } | undefined;
  return latest?.navn;
};

const sectorOf = (record: Record<string, unknown>): RegistryEntity['sector'] | undefined => {
  const meta = (record['virksomhedMetadata'] as Record<string, unknown> | undefined) ?? {};
  const branch = meta['nyesteHovedbranche'] as
    { branchekode?: string; branchetekst?: string } | undefined;
  return branch?.branchekode && branch.branchetekst
    ? { code: branch.branchekode, label: branch.branchetekst }
    : undefined;
};

const addressOf = (record: Record<string, unknown>): string | undefined => {
  const meta = (record['virksomhedMetadata'] as Record<string, unknown> | undefined) ?? {};
  const a = meta['nyesteBeliggenhedsadresse'] as
    | { vejnavn?: string; husnummerFra?: string; postnummer?: number; postdistrikt?: string }
    | undefined;
  if (!a?.vejnavn) return undefined;
  return `${a.vejnavn} ${a.husnummerFra ?? ''}, ${a.postnummer ?? ''} ${a.postdistrikt ?? ''}`
    .replace(/\s+/g, ' ')
    .trim();
};

const statusOf = (record: Record<string, unknown>): RegistryEntity['status'] => {
  const meta = (record['virksomhedMetadata'] as Record<string, unknown> | undefined) ?? {};
  const s = meta['sammensatStatus'];
  if (s === 'NORMAL' || s === 'Aktiv') return 'active';
  if (s === 'OPLØST' || s === 'Ophørt' || s === 'UNDER KONKURS') return 'ceased';
  return 'unknown';
};

export function createCvrAdapter(options: { minIntervalMs?: number } = {}): RegistryAdapter {
  const pace = paced(options.minIntervalMs ?? 1_000);
  return {
    id: 'cvr',
    country: 'DK',
    name: 'Det Centrale Virksomhedsregister',
    host: CVR_HOST,
    terms: {
      url: 'https://erhvervsstyrelsen.dk/vejledning-cvr-data-system-til-system-adgang',
      licence:
        'Public register data, accessed under a system-to-system agreement with Erhvervsstyrelsen.',
      minIntervalMs: options.minIntervalMs ?? 1_000,
      credentials: true,
    },
    searches: ['registryId', 'name', 'domain'],
    async lookup(query: RegistryQuery, ctx): Promise<RegistryEntity | undefined> {
      const user = ctx.credentials?.['CVR_USER'];
      const password = ctx.credentials?.['CVR_PASSWORD'];
      if (!user || !password)
        throw new RegistryUnavailable('cvr', 'no credentials for the system-to-system interface');
      const must = query.registryId
        ? { term: { 'Vrvirksomhed.cvrNummer': Number(query.registryId) } }
        : query.name
          ? { match: { 'Vrvirksomhed.virksomhedMetadata.nyesteNavn.navn': query.name } }
          : query.domain
            ? { match: { 'Vrvirksomhed.hjemmeside.hjemmeside': query.domain } }
            : undefined;
      if (!must) return undefined;
      const body = JSON.stringify({ size: 1, query: { bool: { must: [must] } } });
      const response = await pace(() =>
        ctx.fetch(SEARCH, {
          purpose: 'registry',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`,
          },
          body,
        }),
      );
      if (response.status === 401 || response.status === 403)
        throw new RegistryUnavailable(
          'cvr',
          `the register refused the credentials (${response.status})`,
        );
      if (!response.ok) throw new RegistryUnavailable('cvr', `HTTP ${response.status}`);
      const json = (await response.json()) as {
        hits?: { hits?: { _source?: { Vrvirksomhed?: Record<string, unknown> } }[] };
      };
      const record = json.hits?.hits?.[0]?._source?.Vrvirksomhed;
      if (!record) return undefined;
      const legalName = nameOf(record);
      const cvr = record['cvrNummer'];
      if (!legalName || (typeof cvr !== 'number' && typeof cvr !== 'string')) return undefined;
      const sector = sectorOf(record);
      const address = addressOf(record);
      return {
        registry: 'cvr',
        registryId: String(cvr),
        legalName,
        country: 'DK',
        status: statusOf(record),
        ...(address ? { address } : {}),
        ...(sector ? { sector } : {}),
        headcountBand: bandOf(record),
        // CVR names a parent only through ownership registrations, which this interface
        // does not return in the company record; the group is left unknown here.
        group: {},
        source: {
          url: SEARCH,
          host: CVR_HOST,
          fetchedAt: (ctx.now ?? (() => new Date()))().toISOString(),
        },
        record,
      };
    },
  };
}
