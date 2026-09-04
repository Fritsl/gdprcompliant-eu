import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DnsCollectionSchema,
  DnsServiceMapSchema,
  EvidenceSchema,
  VendorSchema,
  canonicalJson,
  sha256,
  type DnsCollection,
  type DnsRecord,
  type DnsService,
  type DnsServiceMap,
  type Evidence,
  type MappedService,
  type Spf,
  type UnknownToken,
  type Vendor,
} from '@gc/contracts';
import { refTo, type EvidenceIdentity } from '../evidence.js';
import type { Resolver } from './resolver.js';
import {
  entityFields,
  vendorForDnsService,
  vendorMaps,
  type VendorMaps,
} from '../vendors/resolve.js';

// DNS collection (D-01): the records, what they say, and which named services they
// point at, through the curated map. Everything the map does not know is reported as
// unknown with its raw value. Every mapped service becomes a candidate processor on the
// case graph: unresolved (S-07 names the legal entity), with the record as evidence.

export const DNS_SERVICE_MAP_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../data/dns/services.json',
);

export function loadDnsServiceMap(file = DNS_SERVICE_MAP_FILE): DnsServiceMap {
  return DnsServiceMapSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}

// ---- parsing ------------------------------------------------------------------------

export function parseSpf(txt: string): Spf | undefined {
  if (!/^v=spf1(\s|$)/i.test(txt.trim())) return undefined;
  const terms = txt.trim().split(/\s+/).slice(1);
  const includes: string[] = [];
  const mechanisms: string[] = [];
  let all: Spf['all'];
  for (const term of terms) {
    const m = /^([+\-~?]?)include:(.+)$/i.exec(term);
    if (m) {
      includes.push(m[2]!.toLowerCase());
      continue;
    }
    if (/^[+\-~?]?all$/i.test(term)) {
      const q = term[0] && '+-~?'.includes(term[0]) ? term[0] : '+';
      all = `${q}all` as Spf['all'];
      continue;
    }
    mechanisms.push(term);
  }
  return { raw: txt, includes, mechanisms, ...(all ? { all } : {}) };
}

// A verification token is `key=value` or `key:value` with a vendor-looking key. Plain
// prose in a TXT record is not one.
export const TOKEN_PATTERN = /^([A-Za-z][A-Za-z0-9._-]{1,63})\s*[=:]\s*(\S.*)$/;

export function isVerificationToken(txt: string): boolean {
  return TOKEN_PATTERN.test(txt.trim()) && !/^v=(spf1|dmarc1|dkim1)/i.test(txt.trim());
}

const endsWithHost = (host: string, suffix: string): boolean => {
  const h = host.toLowerCase().replace(/\.$/, '');
  const s = suffix.toLowerCase();
  return h === s || h.endsWith(`.${s}`);
};

export function matchService(
  map: DnsServiceMap,
  kind: 'txt' | 'spf_include' | 'mx' | 'cname',
  value: string,
): { service: DnsService; matchedBy: MappedService['matchedBy'] } | undefined {
  for (const service of map.services) {
    switch (kind) {
      case 'txt':
        if (
          service.txtPrefixes.some((p) => value.trim().toLowerCase().startsWith(p.toLowerCase()))
        ) {
          return { service, matchedBy: 'txt_prefix' };
        }
        break;
      case 'spf_include':
        if (service.spfIncludes.some((s) => endsWithHost(value, s)))
          return { service, matchedBy: 'spf_include' };
        break;
      case 'mx':
        if (service.mxSuffixes.some((s) => endsWithHost(value, s)))
          return { service, matchedBy: 'mx_suffix' };
        break;
      case 'cname':
        if (service.cnameSuffixes.some((s) => endsWithHost(value, s)))
          return { service, matchedBy: 'cname_suffix' };
        break;
    }
  }
  return undefined;
}

// ---- collection ---------------------------------------------------------------------

export interface CollectDnsOptions {
  readonly identity: EvidenceIdentity;
  readonly map?: DnsServiceMap;
  // Hostnames under the domain whose CNAMEs are worth a look: mail, email, newsletter.
  readonly cnameLabels?: readonly string[];
}

const DEFAULT_CNAME_LABELS = ['mail', 'email', 'newsletter', 'news', 'em', 'mailer'] as const;

function recordEvidence(
  identity: EvidenceIdentity,
  domain: string,
  records: readonly DnsRecord[],
): Evidence {
  const body = canonicalJson({ domain, records });
  const hash = sha256(body);
  return EvidenceSchema.parse({
    id: `registry_record:${hash.slice(0, 16)}`,
    tenantId: identity.tenantId,
    caseId: identity.caseId,
    ...(identity.scanId !== undefined ? { scanId: identity.scanId } : {}),
    kind: 'registry_record',
    capturedAt: identity.capturedAt,
    source: { registry: 'dns', host: domain },
    body,
    hash,
    caption: `DNS records of ${domain}: ${records.length} record(s)`,
  });
}

export async function collectDns(
  resolver: Resolver,
  domain: string,
  options: CollectDnsOptions,
): Promise<{ collection: DnsCollection; evidence: Evidence[] }> {
  const map = options.map ?? loadDnsServiceMap();
  const name = domain.toLowerCase();
  const records: DnsRecord[] = [];

  for (const txt of await resolver.txt(name)) records.push({ name, type: 'TXT', value: txt });
  for (const txt of await resolver.txt(`_dmarc.${name}`)) {
    records.push({ name: `_dmarc.${name}`, type: 'TXT', value: txt });
  }
  for (const mx of await resolver.mx(name)) {
    records.push({ name, type: 'MX', value: mx.exchange.toLowerCase(), priority: mx.priority });
  }
  for (const label of options.cnameLabels ?? DEFAULT_CNAME_LABELS) {
    const host = `${label}.${name}`;
    for (const target of await resolver.cname(host)) {
      records.push({ name: host, type: 'CNAME', value: target.toLowerCase() });
    }
  }

  const ev = recordEvidence(options.identity, name, records);
  const services: MappedService[] = [];
  const unknown: UnknownToken[] = [];
  let spf: Spf | undefined;
  let dmarc: string | undefined;

  const found = (
    service: DnsService,
    matchedBy: MappedService['matchedBy'],
    record: DnsRecord,
    raw: string,
  ) => {
    if (
      services.some((s) => s.serviceId === service.id && s.matchedBy === matchedBy && s.raw === raw)
    )
      return;
    services.push({
      serviceId: service.id,
      name: service.name,
      jurisdiction: service.jurisdiction,
      role: service.role,
      matchedBy,
      record,
      raw,
    });
  };

  for (const record of records) {
    if (record.type === 'TXT' && record.name === name) {
      const parsed = parseSpf(record.value);
      if (parsed) {
        spf = parsed;
        for (const include of parsed.includes) {
          const hit = matchService(map, 'spf_include', include);
          if (hit) found(hit.service, hit.matchedBy, record, include);
          else unknown.push({ kind: 'spf_include', raw: include, record });
        }
        continue;
      }
      if (isVerificationToken(record.value)) {
        const hit = matchService(map, 'txt', record.value);
        if (hit) found(hit.service, hit.matchedBy, record, record.value);
        else unknown.push({ kind: 'verification_token', raw: record.value, record });
      }
    } else if (record.type === 'TXT' && record.name === `_dmarc.${name}`) {
      if (/^v=dmarc1/i.test(record.value.trim())) dmarc = record.value;
    } else if (record.type === 'MX') {
      const hit = matchService(map, 'mx', record.value);
      if (hit) found(hit.service, hit.matchedBy, record, record.value);
      else unknown.push({ kind: 'mx_exchange', raw: record.value, record });
    } else if (record.type === 'CNAME') {
      const hit = matchService(map, 'cname', record.value);
      if (hit) found(hit.service, hit.matchedBy, record, record.value);
      else unknown.push({ kind: 'cname_target', raw: record.value, record });
    }
  }

  const collection = DnsCollectionSchema.parse({
    domain: name,
    collectedAt: options.identity.capturedAt,
    mapVersion: map.version,
    records,
    ...(spf ? { spf } : {}),
    ...(dmarc ? { dmarc } : {}),
    services,
    unknown,
    evidence: [refTo(ev)],
  });
  return { collection, evidence: [ev] };
}

// Every mapped service, once, as a level-1 candidate on the case graph, with its legal
// entity where the vendor registry has one (S-07) and unresolved where it does not; the
// record is the evidence either way.
export function candidateProcessors(
  collection: DnsCollection,
  identity: EvidenceIdentity,
  maps: VendorMaps = vendorMaps(),
): Vendor[] {
  const byService = new Map<string, MappedService[]>();
  for (const s of collection.services)
    byService.set(s.serviceId, [...(byService.get(s.serviceId) ?? []), s]);
  return [...byService.entries()].map(([serviceId, matches]) => {
    const first = matches[0]!;
    const hosts = [
      ...new Set(
        matches
          // Hosts are what the domain hands mail to or points at; an SPF include is a
          // DNS name for a policy, not a host.
          .filter((m) => m.matchedBy === 'mx_suffix' || m.matchedBy === 'cname_suffix')
          .map((m) => m.raw.toLowerCase().replace(/\.$/, '')),
      ),
    ];
    const entry = vendorForDnsService(serviceId, maps);
    return VendorSchema.parse({
      id: `vendor:dns:${serviceId}:${collection.domain}`,
      tenantId: identity.tenantId,
      caseId: identity.caseId,
      label: first.name,
      jurisdiction: first.jurisdiction,
      role: first.role,
      level: 1,
      hosts,
      resolution: 'unresolved',
      ...(entry ? entityFields(entry) : {}),
      provenance: {
        source: 'observation',
        registryVersion: `dns-services@${collection.mapVersion}${entry ? `, vendors@${maps.registry.version}` : ''}`,
        seenAt: collection.collectedAt,
        evidence: collection.evidence,
      },
    });
  });
}
