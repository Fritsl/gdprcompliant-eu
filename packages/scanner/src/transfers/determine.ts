import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AdequacyListSchema,
  DpfLookupsSchema,
  TransferDeterminationSchema,
  inEea,
  type AdequacyList,
  type DpfLookups,
  type TransferDetermination,
  type TransferSituation,
  type VendorRegistryEntry,
} from '@gc/contracts';
import { vendorMaps, type VendorMaps } from '../vendors/resolve.js';

// Transfer and jurisdiction determination (S-08). Facts with dates, assembled into a
// sentence that says where the contracting entity and its parent sit, what the
// Commission's list says of the country, what the Data Privacy Framework list said on
// the day it was read, and whether the scanned policy names a Chapter V basis. The
// sentence never says a named company is, or is not, lawful to use.

const DATA = resolve(dirname(fileURLToPath(import.meta.url)), '../../data/transfers');
export const ADEQUACY_FILE = resolve(DATA, 'adequacy.json');
export const DPF_FILE = resolve(DATA, 'dpf.json');

export const loadAdequacy = (file = ADEQUACY_FILE): AdequacyList =>
  AdequacyListSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
export const loadDpfLookups = (file = DPF_FILE): DpfLookups =>
  DpfLookupsSchema.parse(JSON.parse(readFileSync(file, 'utf8')));

export interface TransferMaps extends VendorMaps {
  readonly adequacy: AdequacyList;
  readonly dpf: DpfLookups;
}

let cached: TransferMaps | undefined;
export const transferMaps = (): TransferMaps =>
  (cached ??= { ...vendorMaps(), adequacy: loadAdequacy(), dpf: loadDpfLookups() });

// The Chapter V terms a policy can name, in the languages the product reads. Matching
// is on the policy's own words; the terms found are quoted back as written.
const CHAPTER_V_TERMS: RegExp[] = [
  /standard contractual clauses/i,
  /standardkontrakt(?:bestemmelser|klausuler|er)?/i,
  /\bSCCs?\b/,
  /EU-U\.?S\.? Data Privacy Framework/i,
  /Data Privacy Framework/i,
  /adequacy decision/i,
  /tilstrækkelighedsafgørelse/i,
  /binding corporate rules/i,
  /bindende virksomhedsregler/i,
  /\bArt(?:icle|ikel|\.)\s*4[5-9]\b/i,
  /\bChapter V\b/i,
  /\bkapitel V\b/i,
];

export function chapterVBasis(text: string | undefined): TransferDetermination['policyBasis'] {
  if (text === undefined) return { outcome: 'no_policy', terms: [] };
  // In the order the policy says them.
  const found: { term: string; at: number }[] = [];
  for (const re of CHAPTER_V_TERMS) {
    const m = re.exec(text);
    if (m && !found.some((f) => f.term === m[0])) found.push({ term: m[0], at: m.index });
  }
  const terms = found.sort((a, b) => a.at - b.at).map((f) => f.term);
  const distinct = terms.filter((t) => !terms.some((u) => u !== t && u.includes(t)));
  return { outcome: distinct.length > 0 ? 'named' : 'not_named', terms: distinct };
}

export function situationOf(entry: VendorRegistryEntry): TransferSituation {
  if (!inEea(entry.contracting.country)) return 'non_eea_entity';
  if (!inEea(entry.parent.country)) return 'eea_entity_non_eea_parent';
  return 'inside_eea';
}

const countryName = (code: string, locale: 'en' | 'da'): string => {
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
};

export function determineTransfer(
  entry: VendorRegistryEntry,
  options: { readonly maps?: TransferMaps; readonly policyText?: string } = {},
): TransferDetermination {
  const maps = options.maps ?? transferMaps();
  const situation = situationOf(entry);
  const contracting = {
    name: entry.contracting.name,
    country: entry.contracting.country,
    inEea: inEea(entry.contracting.country),
  };
  const parent = {
    name: entry.parent.name,
    country: entry.parent.country,
    inEea: inEea(entry.parent.country),
  };
  const outsideCountry =
    situation === 'non_eea_entity'
      ? contracting.country
      : situation === 'eea_entity_non_eea_parent'
        ? parent.country
        : undefined;
  const decision = outsideCountry
    ? maps.adequacy.decisions.find((d) => d.country === outsideCountry)
    : undefined;
  const adequacy = outsideCountry
    ? {
        country: outsideCountry,
        listed: decision !== undefined,
        ...(decision?.scope ? { scope: decision.scope } : {}),
        verifiedAt: maps.adequacy.verifiedAt,
      }
    : undefined;
  const lookup =
    outsideCountry === 'US' ? maps.dpf.lookups.find((l) => l.vendorId === entry.id) : undefined;
  const dpf =
    outsideCountry === 'US'
      ? {
          status: lookup?.status ?? ('not_checked' as const),
          ...(lookup?.organisation ? { organisation: lookup.organisation } : {}),
          ...(lookup?.lookedUpAt ? { lookedUpAt: lookup.lookedUpAt } : {}),
          source: maps.dpf.source,
        }
      : undefined;
  const policyBasis = chapterVBasis(options.policyText);
  const partial = {
    vendorId: entry.id,
    situation,
    contracting,
    parent,
    adequacy,
    dpf,
    policyBasis,
  };
  const statement = {
    en: statementIn('en', partial),
    da: statementIn('da', partial),
  };
  return TransferDeterminationSchema.parse({
    ...partial,
    ...(adequacy ? { adequacy } : {}),
    ...(dpf ? { dpf } : {}),
    statement,
    registryVersions: {
      vendors: maps.registry.version,
      adequacy: maps.adequacy.version,
      dpf: maps.dpf.version,
    },
  });
}

type Partial = Pick<
  TransferDetermination,
  'situation' | 'contracting' | 'parent' | 'policyBasis'
> & {
  adequacy: TransferDetermination['adequacy'];
  dpf: TransferDetermination['dpf'];
};

const day = (iso: string) => iso.slice(0, 10);

// Where things are, in one paragraph. "Hosted in the EEA" and "controlled from outside
// it" are said in different words on purpose: they are different facts.
function statementIn(locale: 'en' | 'da', d: Partial): string {
  const c = `${d.contracting.name} (${countryName(d.contracting.country, locale)})`;
  const p = `${d.parent.name} (${countryName(d.parent.country, locale)})`;
  const parts: string[] = [];
  if (locale === 'en') {
    if (d.situation === 'inside_eea') {
      parts.push(
        d.contracting.name === d.parent.name
          ? `The contracting entity, ${c}, is established inside the EEA.`
          : `The contracting entity, ${c}, is established inside the EEA, and so is its parent, ${p}.`,
      );
    } else if (d.situation === 'eea_entity_non_eea_parent') {
      parts.push(
        `The contracting entity, ${c}, is established inside the EEA; its ultimate parent, ${p}, is established outside it. The data is handled by an EEA entity that is controlled from outside the EEA.`,
      );
    } else {
      parts.push(
        d.contracting.name === d.parent.name
          ? `The contracting entity, ${c}, is established outside the EEA.`
          : `The contracting entity, ${c}, is established outside the EEA; its ultimate parent is ${p}.`,
      );
    }
    if (d.adequacy) {
      const country = countryName(d.adequacy.country, 'en');
      parts.push(
        d.adequacy.listed
          ? `The Commission's list of adequacy decisions, read ${day(d.adequacy.verifiedAt)}, includes ${country}${d.adequacy.scope ? ` (${d.adequacy.scope})` : ''}.`
          : `The Commission's list of adequacy decisions, read ${day(d.adequacy.verifiedAt)}, does not include ${country}.`,
      );
    }
    if (d.dpf) {
      parts.push(
        d.dpf.status === 'active'
          ? `${d.dpf.organisation} was listed as an active participant in the EU-U.S. Data Privacy Framework when the list was read on ${d.dpf.lookedUpAt}.`
          : d.dpf.status === 'inactive'
            ? `${d.dpf.organisation} was listed as inactive in the EU-U.S. Data Privacy Framework when the list was read on ${d.dpf.lookedUpAt}.`
            : d.dpf.status === 'not_listed'
              ? `No entry for this vendor was found in the EU-U.S. Data Privacy Framework list when it was read on ${d.dpf.lookedUpAt}.`
              : `The EU-U.S. Data Privacy Framework list has not been checked for this vendor.`,
      );
    }
    if (d.situation !== 'inside_eea') {
      parts.push(
        d.policyBasis.outcome === 'named'
          ? `The privacy policy names a Chapter V basis: ${d.policyBasis.terms.map((t) => `“${t}”`).join(', ')}.`
          : d.policyBasis.outcome === 'not_named'
            ? 'The privacy policy names no Chapter V basis for the transfer.'
            : 'No privacy policy was found to read for a Chapter V basis.',
      );
    }
  } else {
    if (d.situation === 'inside_eea') {
      parts.push(
        d.contracting.name === d.parent.name
          ? `Den kontraherende enhed, ${c}, er etableret inden for EØS.`
          : `Den kontraherende enhed, ${c}, er etableret inden for EØS, og det er dens moderselskab, ${p}, også.`,
      );
    } else if (d.situation === 'eea_entity_non_eea_parent') {
      parts.push(
        `Den kontraherende enhed, ${c}, er etableret inden for EØS; det øverste moderselskab, ${p}, er etableret uden for. Oplysningerne behandles af en EØS-enhed, som styres fra et land uden for EØS.`,
      );
    } else {
      parts.push(
        d.contracting.name === d.parent.name
          ? `Den kontraherende enhed, ${c}, er etableret uden for EØS.`
          : `Den kontraherende enhed, ${c}, er etableret uden for EØS; det øverste moderselskab er ${p}.`,
      );
    }
    if (d.adequacy) {
      const country = countryName(d.adequacy.country, 'da');
      parts.push(
        d.adequacy.listed
          ? `Kommissionens liste over tilstrækkelighedsafgørelser, læst ${day(d.adequacy.verifiedAt)}, omfatter ${country}${d.adequacy.scope ? ` (${d.adequacy.scope})` : ''}.`
          : `Kommissionens liste over tilstrækkelighedsafgørelser, læst ${day(d.adequacy.verifiedAt)}, omfatter ikke ${country}.`,
      );
    }
    if (d.dpf) {
      parts.push(
        d.dpf.status === 'active'
          ? `${d.dpf.organisation} stod som aktiv deltager i EU-U.S. Data Privacy Framework, da listen blev læst ${d.dpf.lookedUpAt}.`
          : d.dpf.status === 'inactive'
            ? `${d.dpf.organisation} stod som inaktiv i EU-U.S. Data Privacy Framework, da listen blev læst ${d.dpf.lookedUpAt}.`
            : d.dpf.status === 'not_listed'
              ? `Der blev ikke fundet nogen post for denne leverandør i EU-U.S. Data Privacy Framework-listen, da den blev læst ${d.dpf.lookedUpAt}.`
              : `EU-U.S. Data Privacy Framework-listen er ikke slået op for denne leverandør.`,
      );
    }
    if (d.situation !== 'inside_eea') {
      parts.push(
        d.policyBasis.outcome === 'named'
          ? `Privatlivspolitikken nævner et grundlag efter kapitel V: ${d.policyBasis.terms.map((t) => `“${t}”`).join(', ')}.`
          : d.policyBasis.outcome === 'not_named'
            ? 'Privatlivspolitikken nævner intet grundlag efter kapitel V for overførslen.'
            : 'Der blev ikke fundet nogen privatlivspolitik at læse efter et grundlag efter kapitel V.',
      );
    }
  }
  return parts.join(' ');
}

// Lookups and lists due for a fresh reading.
export interface StaleTransferData {
  readonly what: string;
  readonly detail: string;
}

export function staleTransferData(
  maps: Pick<TransferMaps, 'adequacy' | 'dpf'>,
  now: Date,
  options: { maxAgeDays?: number } = {},
): StaleTransferData[] {
  const maxAgeDays = options.maxAgeDays ?? 180;
  const out: StaleTransferData[] = [];
  if (new Date(`${maps.adequacy.reviewBy}T00:00:00Z`).getTime() <= now.getTime())
    out.push({ what: 'adequacy list', detail: `review was due ${maps.adequacy.reviewBy}` });
  for (const l of maps.dpf.lookups) {
    if (!l.lookedUpAt) continue;
    const ageDays = (now.getTime() - new Date(`${l.lookedUpAt}T00:00:00Z`).getTime()) / 86_400_000;
    if (ageDays > maxAgeDays)
      out.push({
        what: `DPF lookup ${l.vendorId}`,
        detail: `looked up ${Math.floor(ageDays)} days ago, more than ${maxAgeDays}`,
      });
  }
  return out;
}

// Every vendor with a United States entity has a lookup, and every lookup names a vendor.
export function auditTransferData(maps: TransferMaps): string[] {
  const problems: string[] = [];
  const ids = new Set(maps.registry.vendors.map((v) => v.id));
  for (const l of maps.dpf.lookups) {
    if (!ids.has(l.vendorId))
      problems.push(`DPF lookup for ${l.vendorId}: no such vendor in the registry`);
  }
  for (const v of maps.registry.vendors) {
    if (v.contracting.country !== 'US' && v.parent.country !== 'US') continue;
    if (!maps.dpf.lookups.some((l) => l.vendorId === v.id))
      problems.push(
        `${v.id} has a United States entity and no Data Privacy Framework lookup, not even not_checked`,
      );
  }
  return problems;
}
