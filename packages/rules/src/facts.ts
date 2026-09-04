import { inEea, type Company, type EvidenceRef, type RegisterRow } from '@gc/contracts';
import { inferSector, loadSectors, type Sector, type SectorInference } from './sector.js';

// The fact sheet (A-02): what the rules read, as a flat map of named facts. Every fact
// is derived here from the case graph's register and the company, never asserted by a
// rule. A fact that cannot be derived is left out, and a rule that reads it comes out
// undetermined rather than guessed.

export type FactValue = string | number | boolean | readonly string[];
export type Facts = Readonly<Record<string, FactValue>>;

export const FACT_NAMES = {
  'company.country': 'The country the company is established in',
  'company.inEea': 'Whether the company is established inside the EEA',
  'company.sellsService': 'Whether the company sells a service to other businesses',
  'company.headcountMin': 'The smallest headcount the band allows',
  'company.headcountMax': 'The largest headcount the band allows',
  'register.rows': 'How many processing activities the register holds',
  'register.confirmedRows': 'How many of them the company has confirmed',
  'register.activities': 'The activities, by name',
  'register.bases': 'The legal bases relied on',
  'register.categories': 'The data categories processed',
  'register.recipients': 'How many recipients the register names',
  'register.recipientsOutsideEea': 'Whether any recipient sits outside the EEA',
  'register.transfers': 'How many transfer questions the register carries',
  'register.specialCategories': 'Whether special categories of data are processed',
  'register.usesConsent': 'Whether any activity rests on consent',
  'register.usesContract': 'Whether any activity rests on a contract',
  'register.usesLegitimateInterest': 'Whether any activity rests on legitimate interest',
  'site.findingTypes': 'The finding types the latest scan raised',
  'site.setsCookies': 'Whether the site sets cookies on the first load',
  'site.setsNonNecessaryCookies': 'Whether any of them is not necessary',
  'company.sector': 'The sector the company works in, read from the register or the site',
  'company.sectorCode': 'The industry code the business register gives',
  'company.staffUseAiWithCustomerData': 'Whether staff use AI assistants with customer data',
  'company.customerFilesWithMailProvider':
    'Whether customer files sit with the mail and calendar provider',
  'company.processesHealthData': 'Whether the company handles health information about people',
  'company.offersServicesToChildren': 'Whether the company offers services directly to children',
  'company.usesCctv': 'Whether cameras record customers or staff',
  'company.entities': 'How many legal entities the company is made of',
  'company.youngestUsersAge': 'The youngest age the company knowingly serves',
  'company.usesAutomatedDecisions':
    'Whether decisions with a legal or similar effect on people are made automatically',
  'company.hasDpo': 'Whether a data protection officer has been appointed',
} as const;
export type FactName = keyof typeof FACT_NAMES;

const SPECIAL = new Set(['health', 'belief']);

// A headcount band as the register writes it: "10–49", "250+", "1-9".
export function headcountRange(band: string): { min: number; max?: number } | undefined {
  const m = /^(\d+)\s*(?:[–-]\s*(\d+)|\+)?$/.exec(band.trim());
  if (!m) return undefined;
  const min = Number(m[1]);
  if (band.trim().endsWith('+')) return { min };
  return m[2] !== undefined ? { min, max: Number(m[2]) } : { min, max: min };
}

export interface FactSources {
  readonly company: Company;
  readonly rows: readonly RegisterRow[];
  readonly findingTypeIds?: readonly string[];
  readonly cookies?: { readonly total: number; readonly nonNecessary: number };
  // Facts the company answered (D-09); they fill what nothing observed, never overwrite it.
  readonly answers?: Facts;
  readonly sectors?: readonly Sector[];
}

export interface FactSheet {
  readonly facts: Facts;
  // The evidence the register rows rest on: what a duty's `because` names.
  readonly evidence: readonly EvidenceRef[];
  // Where the sector came from, in words.
  readonly sector: SectorInference;
}

export function factsFrom(src: FactSources): FactSheet {
  const f: Record<string, FactValue> = {};
  f['company.country'] = src.company.country;
  f['company.inEea'] = inEea(src.company.country);
  if (src.company.sellsService !== undefined) f['company.sellsService'] = src.company.sellsService;
  if (src.company.headcountBand) {
    const r = headcountRange(src.company.headcountBand);
    if (r) {
      f['company.headcountMin'] = r.min;
      if (r.max !== undefined) f['company.headcountMax'] = r.max;
    }
  }
  const rows = src.rows;
  f['register.rows'] = rows.length;
  f['register.confirmedRows'] = rows.filter((r) => !r.draft).length;
  f['register.activities'] = [...new Set(rows.map((r) => r.name))].sort();
  const bases = [...new Set(rows.flatMap((r) => r.legalBases))].sort();
  const categories = [...new Set(rows.flatMap((r) => r.dataCategories))].sort();
  f['register.bases'] = bases;
  f['register.categories'] = categories;
  f['register.recipients'] = rows.reduce((n, r) => n + r.recipients.length, 0);
  f['register.recipientsOutsideEea'] = rows.some((r) =>
    r.recipients.some((x) => x.country !== undefined && !inEea(x.country)),
  );
  f['register.transfers'] = rows.reduce((n, r) => n + r.transfers.length, 0);
  f['register.specialCategories'] = categories.some((c) => SPECIAL.has(c));
  f['register.usesConsent'] = bases.some((b) => b === 'consent' || b === 'explicit_consent');
  f['register.usesContract'] = bases.includes('contract');
  f['register.usesLegitimateInterest'] = bases.includes('legitimate_interest');
  if (src.findingTypeIds) f['site.findingTypes'] = [...new Set(src.findingTypeIds)].sort();
  if (src.cookies) {
    f['site.setsCookies'] = src.cookies.total > 0;
    f['site.setsNonNecessaryCookies'] = src.cookies.nonNecessary > 0;
  }
  // Health data in the register settles the health question without asking it.
  if (categories.includes('health')) f['company.processesHealthData'] = true;
  if (src.company.sectorCode) f['company.sectorCode'] = src.company.sectorCode;
  if (src.company.entities !== undefined) f['company.entities'] = src.company.entities;
  const sector = inferSector(
    {
      sectorCode: src.company.sectorCode,
      activities: f['register.activities'] as string[],
      categories,
    },
    src.sectors ?? loadSectors(),
  );
  if (sector.sector !== 'unknown') f['company.sector'] = sector.sector;
  for (const [k, v] of Object.entries(src.answers ?? {})) if (f[k] === undefined) f[k] = v;
  const evidence = [
    ...new Map(rows.flatMap((r) => r.evidence).map((e) => [e.evidenceId, e])).values(),
  ];
  return { facts: f, evidence, sector };
}
