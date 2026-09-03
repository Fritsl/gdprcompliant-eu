import type { OutboundFetch } from '@gc/config';
import {
  CtEnumerationSchema,
  EXPOSED_HOSTS_FINDING,
  EvidenceSchema,
  canonicalJson,
  sha256,
  type CtEnumeration,
  type CtHost,
  type Evidence,
  type HostClass,
} from '@gc/contracts';
import { refTo, type EvidenceIdentity } from '../evidence.js';
import type { BrowserPool, ScanTarget } from '../pool.js';

// Certificate transparency enumeration (D-02). Reads what public logs have named under
// a domain from the EU mirror of the log search, classifies each name by what it
// suggests, and sends at most one HEAD to at most a few of them. Capped and paced, so
// an estate with thousands of certificates cannot stall a scan. Nothing here says a
// host is compromised; it says a name is public and whether it answers.

export const CT_MIRROR = 'https://ct.gdprcompliant.eu';
export const DEFAULT_HOST_CAP = 200;
export const DEFAULT_PROBE_CAP = 25;
export const DEFAULT_PROBE_GAP_MS = 250;

// crt.sh's JSON shape, which the mirror serves unchanged.
interface CtLogEntry {
  readonly name_value?: string;
  readonly not_before?: string;
  readonly not_after?: string;
  readonly issuer_name?: string;
}

const CLASSES: readonly [RegExp, HostClass][] = [
  [
    /^(dev|develop|development|staging|stage|stg|test|testing|qa|uat|sandbox|preprod|pre-prod|demo|beta|canary|preview|old|new|tmp|temp)(\d*)[.-]/i,
    'non_production',
  ],
  [
    /^(admin|intranet|internal|vpn|remote|mail|webmail|owa|exchange|autodiscover|smtp|imap|pop|ftp|sftp|git|gitlab|jenkins|ci|grafana|kibana|jira|confluence|db|sql|mysql|postgres|phpmyadmin|backup|monitor|nagios|zabbix|vcenter|rdp|citrix|portal)(\d*)[.-]/i,
    'internal_service',
  ],
  [/^(api|graphql|ws|socket|auth|sso|oauth|id|identity|login)(\d*)[.-]/i, 'api'],
  [/^(cdn|static|assets|img|images|media|files|download|downloads)(\d*)[.-]/i, 'static'],
  [/^(shop|store|checkout|pay|payment|payments|billing|order|orders|cart)(\d*)[.-]/i, 'commerce'],
];

export function classifyHost(host: string, domain: string): HostClass {
  const h = host.toLowerCase();
  if (h.startsWith('*.')) return 'wildcard';
  if (h === domain.toLowerCase() || h === `www.${domain.toLowerCase()}`) return 'production';
  const label = h.endsWith(`.${domain.toLowerCase()}`)
    ? h.slice(0, -(domain.length + 1)) + '.'
    : h + '.';
  for (const [re, cls] of CLASSES) if (re.test(label)) return cls;
  return 'other';
}

export function hostsFromEntries(
  entries: readonly CtLogEntry[],
  domain: string,
): Omit<CtHost, 'probe'>[] {
  const byHost = new Map<
    string,
    { first?: string; last?: string; issuers: Set<string>; certificates: number }
  >();
  const suffix = `.${domain.toLowerCase()}`;
  for (const e of entries) {
    for (const raw of (e.name_value ?? '').split(/\s+/)) {
      const host = raw.trim().toLowerCase().replace(/\.$/, '');
      if (!host) continue;
      if (host !== domain.toLowerCase() && !host.endsWith(suffix) && !host.startsWith('*.'))
        continue;
      const cur = byHost.get(host) ?? { issuers: new Set<string>(), certificates: 0 };
      cur.certificates += 1;
      if (e.issuer_name) cur.issuers.add(e.issuer_name);
      const before = toIso(e.not_before);
      const after = toIso(e.not_after);
      if (before && (!cur.first || before < cur.first)) cur.first = before;
      if (after && (!cur.last || after > cur.last)) cur.last = after;
      byHost.set(host, cur);
    }
  }
  return [...byHost.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([host, v]) => ({
      host,
      class: classifyHost(host, domain),
      ...(v.first ? { firstSeen: v.first } : {}),
      ...(v.last ? { lastSeen: v.last } : {}),
      issuers: [...v.issuers].sort(),
      certificates: v.certificates,
    }));
}

function toIso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  // The log gives UTC without saying so; a bare timestamp is read as UTC, not local.
  const v = value.trim().replace(' ', 'T');
  const d = new Date(/[zZ]$|[+-]dd:?dd$/.test(v) ? v : v + 'Z');
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export interface EnumerateOptions {
  readonly identity: EvidenceIdentity;
  readonly mirror?: string;
  readonly hostCap?: number;
  // The pool to send the single HEAD per host through; none means no probing at all.
  readonly pool?: BrowserPool;
  readonly probeCap?: number;
  readonly probeGapMs?: number;
  readonly probeTimeoutMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Which hosts deserve the one HEAD: the ones whose name suggests something that was not
// meant for the public, first.
const PROBE_PRIORITY: readonly HostClass[] = [
  'non_production',
  'internal_service',
  'api',
  'commerce',
  'other',
  'static',
];

async function probeHosts(
  pool: BrowserPool,
  target: ScanTarget,
  hosts: readonly string[],
  gapMs: number,
  timeoutMs: number,
) {
  return pool.run(target, async (_page, context) => {
    const out = new Map<string, { status: number; reachable: boolean }>();
    for (const [i, host] of hosts.entries()) {
      if (i > 0) await sleep(gapMs);
      try {
        const r = await context.request.head(`https://${host}/`, {
          maxRedirects: 0,
          timeout: timeoutMs,
        });
        out.set(host, { status: r.status(), reachable: true });
      } catch {
        out.set(host, { status: 0, reachable: false });
      }
    }
    return out;
  });
}

export async function enumerateCertificates(
  outbound: OutboundFetch,
  domain: string,
  options: EnumerateOptions,
): Promise<{ enumeration: CtEnumeration; evidence: Evidence[] }> {
  const { identity } = options;
  const mirror = options.mirror ?? CT_MIRROR;
  const hostCap = options.hostCap ?? DEFAULT_HOST_CAP;
  const url = `${mirror}/?q=${encodeURIComponent(`%.${domain}`)}&output=json`;
  const response = await outbound(url, { method: 'GET', purpose: 'registry' });
  const text = await response.text();
  let entries: CtLogEntry[] = [];
  if (response.ok) {
    try {
      const parsed = JSON.parse(text) as unknown;
      entries = Array.isArray(parsed) ? (parsed as CtLogEntry[]) : [];
    } catch {
      entries = [];
    }
  }

  const all = hostsFromEntries(entries, domain);
  const capped = all.length > hostCap;
  const kept: CtHost[] = all.slice(0, hostCap);

  let probed = 0;
  if (options.pool && kept.length > 0) {
    const cap = options.probeCap ?? DEFAULT_PROBE_CAP;
    const candidates = kept
      .filter((h) => h.class !== 'wildcard' && h.class !== 'production')
      .sort((a, b) => PROBE_PRIORITY.indexOf(a.class) - PROBE_PRIORITY.indexOf(b.class))
      .slice(0, cap)
      .map((h) => h.host);
    if (candidates.length > 0) {
      const results = await probeHosts(
        options.pool,
        { url: `https://${domain}/` },
        candidates,
        options.probeGapMs ?? DEFAULT_PROBE_GAP_MS,
        options.probeTimeoutMs ?? 5_000,
      );
      for (const h of kept) {
        const r = results.get(h.host);
        if (r) (h as { probe?: CtHost['probe'] }).probe = r;
      }
      probed = candidates.length;
    }
  }

  const body = canonicalJson({
    domain,
    source: url,
    status: response.status,
    entries: entries.length,
    hosts: kept,
  });
  const hash = sha256(body);
  const ev = EvidenceSchema.parse({
    id: `registry_record:${hash.slice(0, 16)}`,
    tenantId: identity.tenantId,
    caseId: identity.caseId,
    ...(identity.scanId !== undefined ? { scanId: identity.scanId } : {}),
    kind: 'registry_record',
    capturedAt: identity.capturedAt,
    source: { registry: 'certificate-transparency', url, host: domain },
    body,
    hash,
    caption: `Certificate transparency: ${kept.length} host(s) named under ${domain}${capped ? ' (capped)' : ''}`,
  });

  const exposed = kept.filter(
    (h) =>
      (h.class === 'non_production' || h.class === 'internal_service') &&
      h.probe?.reachable !== false,
  );
  const observation =
    exposed.length > 0
      ? {
          findingTypeId: EXPOSED_HOSTS_FINDING,
          outcome: 'fail' as const,
          summary: `${exposed.length} host(s) under ${domain} are named in public certificate logs and look like non-production or internal services: ${exposed
            .map(
              (h) =>
                `${h.host}${h.probe ? (h.probe.reachable ? ` (answers ${h.probe.status})` : ' (did not answer)') : ''}`,
            )
            .join(', ')}. A name in a public log is not a breach; it is a place to check.`,
          evidence: [refTo(ev)],
        }
      : {
          findingTypeId: EXPOSED_HOSTS_FINDING,
          outcome: 'pass' as const,
          summary:
            kept.length === 0
              ? `No host under ${domain} is named in public certificate logs.`
              : `${kept.length} host(s) named under ${domain}; none looks like a non-production or internal service.`,
          evidence: [],
        };

  const enumeration = CtEnumerationSchema.parse({
    domain,
    source: url,
    fetchedAt: identity.capturedAt,
    entries: entries.length,
    hosts: kept,
    capped,
    probed,
    observation,
    evidence: [refTo(ev)],
  });
  return { enumeration, evidence: [ev] };
}
