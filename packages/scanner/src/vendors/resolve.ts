import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  VendorRegistrySchema,
  inEea,
  type DnsServiceMap,
  type RecipientHostMap,
  type Vendor,
  type VendorRegistry,
  type VendorRegistryEntry,
} from '@gc/contracts';
import { loadDnsServiceMap } from '../dns/collect.js';
import { loadRecipientHosts } from '../checks/recipients.js';

// Host to legal entity (S-07). The registry names, per vendor, the entity a customer in
// the EEA contracts with and the ultimate parent; the two maps the scanner already
// keeps (request hosts, DNS record patterns) link to it by id. Resolution is a lookup,
// never a guess: a host nothing covers comes back unresolved with the host on it.

export const VENDOR_REGISTRY_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../data/vendors/registry.json',
);

export function loadVendorRegistry(file = VENDOR_REGISTRY_FILE): VendorRegistry {
  return VendorRegistrySchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}

export interface VendorMaps {
  readonly registry: VendorRegistry;
  readonly dns: DnsServiceMap;
  readonly recipients: RecipientHostMap;
}

let cached: VendorMaps | undefined;
export const vendorMaps = (): VendorMaps =>
  (cached ??= {
    registry: loadVendorRegistry(),
    dns: loadDnsServiceMap(),
    recipients: loadRecipientHosts(),
  });

export type HostResolution =
  | {
      readonly host: string;
      readonly resolution: 'resolved';
      readonly entry: VendorRegistryEntry;
      readonly suffix: string;
    }
  | { readonly host: string; readonly resolution: 'unresolved' }
  | {
      readonly host: string;
      readonly resolution: 'ambiguous';
      readonly entries: readonly VendorRegistryEntry[];
      readonly suffix: string;
    };

const normalise = (host: string) => host.toLowerCase().replace(/\.$/, '');
const endsWithHost = (host: string, suffix: string): boolean =>
  host === suffix || host.endsWith(`.${suffix}`);

// Every suffix an entry answers for: its own, the recipient hosts it claims, and the
// MX and CNAME suffixes of the DNS services it claims.
export function suffixesOf(entry: VendorRegistryEntry, maps: VendorMaps): string[] {
  const out = new Set<string>(entry.hostSuffixes.map(normalise));
  for (const id of entry.recipientHosts) {
    const r = maps.recipients.hosts.find((h) => h.id === id);
    for (const s of r?.hostSuffixes ?? []) out.add(normalise(s));
  }
  for (const id of entry.dnsServices) {
    const s = maps.dns.services.find((d) => d.id === id);
    for (const x of [...(s?.mxSuffixes ?? []), ...(s?.cnameSuffixes ?? [])]) out.add(normalise(x));
  }
  return [...out];
}

// The longest matching suffix wins; two entries on the same longest suffix are ambiguous.
export function resolveHost(host: string, maps: VendorMaps = vendorMaps()): HostResolution {
  const h = normalise(host);
  let best: { suffix: string; entries: VendorRegistryEntry[] } | undefined;
  for (const entry of maps.registry.vendors) {
    for (const suffix of suffixesOf(entry, maps)) {
      if (!endsWithHost(h, suffix)) continue;
      if (!best || suffix.length > best.suffix.length) best = { suffix, entries: [entry] };
      else if (suffix.length === best.suffix.length && !best.entries.includes(entry))
        best.entries.push(entry);
    }
  }
  if (!best) return { host, resolution: 'unresolved' };
  if (best.entries.length === 1)
    return { host, resolution: 'resolved', entry: best.entries[0]!, suffix: best.suffix };
  return { host, resolution: 'ambiguous', entries: best.entries, suffix: best.suffix };
}

// Every host, in the order given; nothing is dropped.
export const resolveHosts = (hosts: readonly string[], maps: VendorMaps = vendorMaps()) =>
  hosts.map((h) => resolveHost(h, maps));

export const vendorForDnsService = (
  serviceId: string,
  maps: VendorMaps = vendorMaps(),
): VendorRegistryEntry | undefined =>
  maps.registry.vendors.find((v) => v.dnsServices.includes(serviceId));

export const vendorForRecipient = (
  recipientId: string,
  maps: VendorMaps = vendorMaps(),
): VendorRegistryEntry | undefined =>
  maps.registry.vendors.find((v) => v.recipientHosts.includes(recipientId));

// The fields a resolved entry contributes to a vendor row: the contracting entity, where
// it and its parent sit, and whether the transfer question arises at all. It arises when
// either sits outside the EEA; the mechanism is the case's to establish, never assumed.
export function entityFields(
  entry: VendorRegistryEntry,
): Pick<Vendor, 'legalEntity' | 'jurisdiction' | 'parentJurisdiction' | 'transfer' | 'resolution'> {
  const outsideEea = !inEea(entry.contracting.country) || !inEea(entry.parent.country);
  return {
    legalEntity: {
      name: entry.contracting.name,
      ...(entry.contracting.registry ? { registry: entry.contracting.registry } : {}),
      ...(entry.contracting.registryId ? { registryId: entry.contracting.registryId } : {}),
    },
    jurisdiction: entry.contracting.country,
    ...(entry.parent.country !== entry.contracting.country
      ? { parentJurisdiction: entry.parent.country }
      : {}),
    transfer: { outsideEea, mechanism: 'unknown' },
    resolution: 'resolved',
  };
}

// Entries due for a fresh reading: past their review date, or read too long ago.
export interface StaleEntry {
  readonly id: string;
  readonly reason: 'review_due' | 'verified_long_ago';
  readonly detail: string;
}

export function staleEntries(
  registry: VendorRegistry,
  now: Date,
  options: { maxAgeDays?: number } = {},
): StaleEntry[] {
  const maxAgeDays = options.maxAgeDays ?? 180;
  const out: StaleEntry[] = [];
  for (const v of registry.vendors) {
    if (new Date(`${v.reviewBy}T00:00:00Z`).getTime() <= now.getTime())
      out.push({ id: v.id, reason: 'review_due', detail: `review was due ${v.reviewBy}` });
    const ageDays = (now.getTime() - new Date(v.provenance.verifiedAt).getTime()) / 86_400_000;
    if (ageDays > maxAgeDays)
      out.push({
        id: v.id,
        reason: 'verified_long_ago',
        detail: `read ${Math.floor(ageDays)} days ago, more than ${maxAgeDays}`,
      });
  }
  return out;
}

// The three maps agree: every link points at a real entry, no map entry is claimed
// twice. A map entry nobody claims is a gap to report, not an error.
export interface RegistryAudit {
  readonly problems: string[];
  readonly unclaimed: { kind: 'dns_service' | 'recipient_host'; id: string }[];
}

export function auditRegistry(maps: VendorMaps = vendorMaps()): RegistryAudit {
  const problems: string[] = [];
  const claimedDns = new Map<string, string>();
  const claimedRecipients = new Map<string, string>();
  for (const v of maps.registry.vendors) {
    for (const id of v.dnsServices) {
      if (!maps.dns.services.some((s) => s.id === id))
        problems.push(`${v.id} links DNS service ${id}, which the DNS map does not have`);
      const other = claimedDns.get(id);
      if (other) problems.push(`DNS service ${id} is claimed by both ${other} and ${v.id}`);
      claimedDns.set(id, v.id);
    }
    for (const id of v.recipientHosts) {
      if (!maps.recipients.hosts.some((h) => h.id === id))
        problems.push(`${v.id} links recipient host ${id}, which the host map does not have`);
      const other = claimedRecipients.get(id);
      if (other) problems.push(`recipient host ${id} is claimed by both ${other} and ${v.id}`);
      claimedRecipients.set(id, v.id);
    }
    if (new Date(v.reviewBy).getTime() <= new Date(v.provenance.verifiedAt).getTime())
      problems.push(
        `${v.id}: reviewBy ${v.reviewBy} is not after verifiedAt ${v.provenance.verifiedAt}`,
      );
  }
  const unclaimed: RegistryAudit['unclaimed'] = [
    ...maps.dns.services
      .filter((s) => !claimedDns.has(s.id))
      .map((s) => ({ kind: 'dns_service' as const, id: s.id })),
    ...maps.recipients.hosts
      .filter((h) => !claimedRecipients.has(h.id))
      .map((h) => ({ kind: 'recipient_host' as const, id: h.id })),
  ];
  return { problems, unclaimed };
}
