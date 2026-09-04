import { eq } from 'drizzle-orm';
import type { CaseLane, Company } from '@gc/contracts';
import { headcountRange, inferSector, loadSectors, type Sector } from '@gc/rules';
import type { Connection } from './client.js';
import { caseCompany } from './findings.js';
import { registerRows } from './register.js';
import { cases, evidence, vendors } from './schema.js';
import { withTenant } from './tenant.js';

// Qualification (L-01): a score from public facts that decides one thing, whether a
// person reaches out. It is stored on the case with the signals that made it, never
// exported or rendered for the customer, and gates nothing: the case is the same case
// in either lane. Every signal says in words what it read.

export const LANE_SIGNAL_IDS = [
  'headcount',
  'sector',
  'subdomains',
  'enterprise',
  'entities',
  'countries',
  'regulated',
] as const;
export type LaneSignalId = (typeof LANE_SIGNAL_IDS)[number];

export interface LaneSignal {
  readonly id: LaneSignalId;
  readonly label: string;
  readonly value: string;
  readonly points: number;
  readonly because: string;
}

export interface LaneInput {
  readonly headcountBand?: string | undefined;
  readonly sector: string;
  readonly sectorLabel?: string | undefined;
  readonly regulated: boolean;
  readonly subdomains: number;
  readonly enterpriseSystems: readonly string[];
  readonly entities: number;
  readonly countries: number;
}

export interface LaneScore {
  readonly score: number;
  readonly lane: CaseLane;
  readonly signals: readonly LaneSignal[];
}

// At and above this a person reaches out; below it the product is the whole service.
export const HUMAN_LANE_THRESHOLD = 50;

const LABELS: Record<LaneSignalId, string> = {
  headcount: 'Headcount band',
  sector: 'Sector',
  subdomains: 'Subdomains',
  enterprise: 'Enterprise systems',
  entities: 'Entities',
  countries: 'Countries',
  regulated: 'Regulated sector',
};

// Systems a small company does not run: seeing one means budget and a counterpart.
export const ENTERPRISE_SYSTEMS: readonly { id: string; pattern: RegExp; example: string }[] = [
  { id: 'salesforce', pattern: /salesforce|force\.com|pardot/i, example: 'cdn.salesforce.com' },
  { id: 'hubspot', pattern: /hubspot|hs-scripts|hsforms/i, example: 'js.hs-scripts.com' },
  { id: 'sap', pattern: /\bsap\b|hybris|successfactors/i, example: 'SAP SE' },
  { id: 'workday', pattern: /workday/i, example: 'wd3.myworkday.com' },
  { id: 'servicenow', pattern: /servicenow|service-now/i, example: 'company.service-now.com' },
  { id: 'oracle', pattern: /oracle|eloqua|netsuite/i, example: 'system.netsuite.com' },
  {
    id: 'microsoft-dynamics',
    pattern: /dynamics\.com|dynamics 365/i,
    example: 'org.crm4.dynamics.com',
  },
  { id: 'adobe-experience', pattern: /marketo|demdex|omtrdc|adobedtm/i, example: 'dpm.demdex.net' },
];

// Sectors where growth shows up as staff and systems before it shows up in the register.
const SYSTEM_HEAVY_SECTORS = new Set(['software', 'professional-services']);

export function scoreLane(input: LaneInput): LaneScore {
  const signals: LaneSignal[] = [];
  const range = input.headcountBand ? headcountRange(input.headcountBand) : undefined;
  const headcountPoints = !range
    ? 0
    : range.min >= 250
      ? 35
      : range.min >= 50
        ? 20
        : range.min >= 10
          ? 8
          : 0;
  signals.push({
    id: 'headcount',
    label: LABELS.headcount,
    value: input.headcountBand ?? 'Unknown',
    points: headcountPoints,
    because: range
      ? `the register bands the company at ${input.headcountBand}`
      : 'no headcount band from the register or an answer',
  });
  const sectorPoints = SYSTEM_HEAVY_SECTORS.has(input.sector) ? 5 : 0;
  signals.push({
    id: 'sector',
    label: LABELS.sector,
    value: input.sectorLabel ?? (input.sector === 'unknown' ? 'Unknown' : input.sector),
    points: sectorPoints,
    because:
      input.sector === 'unknown'
        ? 'nothing read points at a sector'
        : sectorPoints > 0
          ? `${input.sectorLabel ?? input.sector} runs on systems before it runs on staff`
          : `${input.sectorLabel ?? input.sector} on its own says little about budget`,
  });
  const subdomainPoints = input.subdomains >= 10 ? 15 : input.subdomains >= 4 ? 8 : 0;
  signals.push({
    id: 'subdomains',
    label: LABELS.subdomains,
    value: String(input.subdomains),
    points: subdomainPoints,
    because: `${input.subdomains} host(s) under the domain were seen`,
  });
  const systems = [...new Set(input.enterpriseSystems)].sort();
  signals.push({
    id: 'enterprise',
    label: LABELS.enterprise,
    value: systems.length > 0 ? systems.join(', ') : 'None detected',
    points: Math.min(30, systems.length * 15),
    because:
      systems.length > 0
        ? `${systems.join(' and ')} seen on the site or among the recipients`
        : 'no enterprise system among the hosts or recipients',
  });
  signals.push({
    id: 'entities',
    label: LABELS.entities,
    value: String(input.entities),
    points: input.entities > 1 ? 15 : 0,
    because: input.entities > 1 ? `${input.entities} legal entities` : 'one legal entity',
  });
  signals.push({
    id: 'countries',
    label: LABELS.countries,
    value: String(input.countries),
    points: input.countries > 1 ? 15 : 0,
    because:
      input.countries > 1
        ? `the same name is served under ${input.countries} country domains`
        : 'one country domain',
  });
  signals.push({
    id: 'regulated',
    label: LABELS.regulated,
    value: input.regulated ? 'Yes' : 'No',
    points: input.regulated ? 15 : 0,
    because: input.regulated
      ? `${input.sectorLabel ?? input.sector} is a regulated sector`
      : 'not a regulated sector',
  });
  const score = Math.min(
    100,
    signals.reduce((n, s) => n + s.points, 0),
  );
  return { score, lane: score >= HUMAN_LANE_THRESHOLD ? 'human' : 'self-serve', signals };
}

export interface LaneFacts {
  readonly company: Company;
  // Every host the scan saw, own and third-party.
  readonly hosts: readonly string[];
  // What the recipients resolved to: their hosts and labels.
  readonly vendorHosts: readonly string[];
  readonly vendorLabels: readonly string[];
  readonly activities: readonly string[];
  readonly categories: readonly string[];
  readonly sectors?: readonly Sector[] | undefined;
}

const registrable = (host: string): { name: string; tld: string } | undefined => {
  const parts = host.toLowerCase().split('.');
  if (parts.length < 2) return undefined;
  const tld = parts[parts.length - 1]!;
  const name = parts[parts.length - 2]!;
  return { name, tld };
};

// The signals read from what the case holds: pure, so a test can hand it facts.
export function laneInputFrom(f: LaneFacts): LaneInput {
  const sectors = f.sectors ?? loadSectors();
  const inferred = inferSector(
    { sectorCode: f.company.sectorCode, activities: f.activities, categories: f.categories },
    sectors,
  );
  const sector = sectors.find((s) => s.id === inferred.sector);
  const domain = f.company.domain.toLowerCase();
  const own = new Set(
    f.hosts.map((h) => h.toLowerCase()).filter((h) => h === domain || h.endsWith(`.${domain}`)),
  );
  const apex = registrable(domain);
  const countryDomains = new Set<string>([f.company.country.toLowerCase()]);
  if (apex)
    for (const h of f.hosts) {
      const r = registrable(h);
      if (r && r.name === apex.name && r.tld.length === 2 && r.tld !== apex.tld)
        countryDomains.add(r.tld);
    }
  const haystack = [...f.hosts, ...f.vendorHosts, ...f.vendorLabels];
  const enterpriseSystems = ENTERPRISE_SYSTEMS.filter((s) =>
    haystack.some((x) => s.pattern.test(x)),
  ).map((s) => s.id);
  return {
    headcountBand: f.company.headcountBand,
    sector: inferred.sector,
    sectorLabel: sector?.title['en'],
    regulated: sector?.regulated ?? false,
    subdomains: [...own].filter((h) => h !== domain).length,
    enterpriseSystems,
    entities: f.company.entities ?? 1,
    countries: countryDomains.size,
  };
}

// Score the case from what it holds and store the lane, the score and the signals.
export async function assignLane(
  connection: Connection,
  tenantId: string,
  caseId: string,
  options: { readonly sectors?: readonly Sector[] } = {},
): Promise<LaneScore | undefined> {
  const company = await caseCompany(connection, tenantId, caseId);
  if (!company) return undefined;
  const rows = await registerRows(connection, tenantId, caseId);
  const [observed, vendorRows] = await withTenant(connection, tenantId, async (db) => [
    await db
      .select({ observed: evidence.observed })
      .from(evidence)
      .where(eq(evidence.caseId, caseId)),
    await db
      .select({ hosts: vendors.hosts, label: vendors.label })
      .from(vendors)
      .where(eq(vendors.caseId, caseId)),
  ]);
  const hosts = observed
    .map((r) => (r.observed as { host?: unknown } | null)?.host)
    .filter((h): h is string => typeof h === 'string' && h.length > 0);
  const result = scoreLane(
    laneInputFrom({
      company,
      hosts,
      vendorHosts: vendorRows.flatMap((v) => (Array.isArray(v.hosts) ? (v.hosts as string[]) : [])),
      vendorLabels: vendorRows.map((v) => v.label),
      activities: rows.map((r) => r.name),
      categories: rows.flatMap((r) => r.dataCategories),
      sectors: options.sectors,
    }),
  );
  await withTenant(connection, tenantId, (db) =>
    db
      .update(cases)
      .set({ lane: result.lane, laneScore: result.score, laneSignals: result.signals })
      .where(eq(cases.id, caseId)),
  );
  return result;
}

// What an internal reader gets; nothing here reaches a customer surface.
export async function laneOf(
  connection: Connection,
  tenantId: string,
  caseId: string,
): Promise<LaneScore | undefined> {
  const [row] = await withTenant(connection, tenantId, (db) =>
    db
      .select({ lane: cases.lane, score: cases.laneScore, signals: cases.laneSignals })
      .from(cases)
      .where(eq(cases.id, caseId))
      .limit(1),
  );
  if (!row) return undefined;
  return {
    lane: row.lane as CaseLane,
    score: row.score,
    signals: (row.signals as LaneSignal[] | null) ?? [],
  };
}
