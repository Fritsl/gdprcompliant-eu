import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EvidenceSchema,
  RECIPIENT_CHECKS,
  RecipientHostMapSchema,
  RecipientObservationSchema,
  canonicalJson,
  inEea,
  sha256,
  type Evidence,
  type PassCapture,
  type RecipientHost,
  type RecipientHostMap,
  type RecipientObservation,
} from '@gc/contracts';
import { refTo, type EvidenceIdentity } from '../evidence.js';
import { determineTransfer, transferMaps, type TransferMaps } from '../transfers/determine.js';
import { vendorForRecipient } from '../vendors/resolve.js';

// Recipients (S-15): read from the first load, before anyone was asked. Every request to
// a host that is not the site's own is a recipient of the visitor's address and whatever
// else the request carries. Two things are worth a finding on their own: a recipient
// the map places outside the EEA, and a web font fetched from someone else's server.
// The map is curated with provenance; a host it does not know is left alone here.

export const RECIPIENT_HOSTS_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../data/recipients/hosts.json',
);

let cached: RecipientHostMap | undefined;
export function loadRecipientHosts(file = RECIPIENT_HOSTS_FILE): RecipientHostMap {
  if (file === RECIPIENT_HOSTS_FILE && cached) return cached;
  const map = RecipientHostMapSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  if (file === RECIPIENT_HOSTS_FILE) cached = map;
  return map;
}

const endsWithHost = (host: string, suffix: string) =>
  host === suffix || host.endsWith(`.${suffix}`);

export function recipientFor(map: RecipientHostMap, host: string): RecipientHost | undefined {
  const h = host.toLowerCase();
  return map.hosts.find((r) => r.hostSuffixes.some((s) => endsWithHost(h, s)));
}

export interface RecipientChecks {
  readonly observations: readonly RecipientObservation[];
  readonly evidence: readonly Evidence[];
}

const ownHost = (capture: PassCapture): { own: string; bare: string } => {
  const own = new URL(capture.finalUrl).hostname.toLowerCase();
  return { own, bare: own.replace(/^www\./, '') };
};

export function recipientChecks(
  capture: PassCapture,
  identity: EvidenceIdentity,
  options: {
    readonly map?: RecipientHostMap;
    // The vendor registry with the adequacy list and DPF lookups (S-08).
    readonly transfers?: TransferMaps;
    // The visible text of the privacy policy, read for a Chapter V basis.
    readonly policyText?: string;
  } = {},
): RecipientChecks {
  const map = options.map ?? loadRecipientHosts();
  const { own, bare } = ownHost(capture);
  const thirdParty = capture.requests.filter((r) => {
    const h = r.host.toLowerCase();
    return h !== own && h !== bare && !h.endsWith(`.${bare}`);
  });
  const evidence: Evidence[] = [];
  const observations: RecipientObservation[] = [];
  const row = (body: string, caption: string): Evidence => {
    const hash = sha256(body);
    const e = EvidenceSchema.parse({
      id: `http_request:${hash.slice(0, 16)}`,
      tenantId: identity.tenantId,
      caseId: identity.caseId,
      ...(identity.scanId !== undefined ? { scanId: identity.scanId } : {}),
      kind: 'http_request',
      capturedAt: identity.capturedAt,
      source: { url: capture.finalUrl, host: own, pass: 'A' },
      body,
      hash,
      caption,
    });
    if (!evidence.some((x) => x.hash === e.hash)) evidence.push(e);
    return e;
  };
  const observe = (
    check: keyof typeof RECIPIENT_CHECKS,
    outcome: RecipientObservation['outcome'],
    summary: string,
    detail: Record<string, unknown>,
    hosts: string[],
    refs: Evidence[],
  ) =>
    observations.push(
      RecipientObservationSchema.parse({
        check,
        findingTypeId: RECIPIENT_CHECKS[check],
        outcome,
        summary,
        detail,
        hosts,
        evidence: refs.map((e) => refTo(e)),
      }),
    );

  // 1. Transfers: recipients the map places outside the EEA.
  const byHost = new Map<string, { count: number; recipient: RecipientHost }>();
  for (const r of thirdParty) {
    const recipient = recipientFor(map, r.host);
    if (!recipient || inEea(recipient.jurisdiction)) continue;
    const key = r.host.toLowerCase();
    const entry = byHost.get(key) ?? { count: 0, recipient };
    entry.count += 1;
    byHost.set(key, entry);
  }
  const outside = [...byHost.entries()]
    .map(([host, e]) => ({
      host,
      requests: e.count,
      recipient: e.recipient.name,
      jurisdiction: e.recipient.jurisdiction,
    }))
    .sort((a, b) => a.host.localeCompare(b.host));
  // Where the vendor registry knows the entity behind a recipient, the determination
  // (S-08) rides on the observation: the contracting entity and the parent, each
  // against the EEA, the lists as read, and the policy's Chapter V words.
  const tmaps = options.transfers ?? transferMaps();
  const determined = outside.map((o) => {
    const entry = vendorForRecipient(byHost.get(o.host)!.recipient.id, tmaps);
    if (!entry) return o;
    const determination = determineTransfer(entry, {
      maps: tmaps,
      ...(options.policyText !== undefined ? { policyText: options.policyText } : {}),
    });
    return { ...o, determination };
  });
  const statements = [
    ...new Map(
      determined
        .filter((o) => 'determination' in o)
        .map((o) => [o.determination.vendorId, o.determination.statement.en] as const),
    ).values(),
  ];
  const registryVersions = {
    vendors: tmaps.registry.version,
    adequacy: tmaps.adequacy.version,
    dpf: tmaps.dpf.version,
  };
  if (outside.length > 0) {
    const ev = row(
      canonicalJson({
        page: capture.finalUrl,
        pass: 'A',
        outside: determined,
        mapVersion: map.version,
        registryVersions,
      }),
      `requests from the first load of ${own} to hosts established outside the EEA`,
    );
    observe(
      'transfers',
      'fail',
      [
        `${own} sends visitors' requests to ${outside.length} host(s) whose operator the map places outside the EEA, before anyone is asked: ${outside.map((o) => `${o.host} (${o.recipient}, ${o.jurisdiction})`).join(', ')}.`,
        ...statements,
      ].join(' '),
      { outside: determined, mapVersion: map.version, registryVersions },
      outside.map((o) => o.host),
      [ev],
    );
  } else {
    observe(
      'transfers',
      'pass',
      thirdParty.length === 0
        ? `${own} contacts no other host on the first load.`
        : `${own} contacts ${new Set(thirdParty.map((r) => r.host)).size} other host(s) on the first load, none the map places outside the EEA.`,
      { mapVersion: map.version, thirdParty: [...new Set(thirdParty.map((r) => r.host))].sort() },
      [],
      [],
    );
  }

  // 2. Fonts fetched from someone else's server.
  const fontHosts = [
    ...new Set(
      thirdParty.filter((r) => r.resourceType === 'font').map((r) => r.host.toLowerCase()),
    ),
  ].sort();
  if (fontHosts.length > 0) {
    const fonts = thirdParty
      .filter((r) => r.resourceType === 'font')
      .map((r) => ({ url: r.url, host: r.host.toLowerCase() }))
      .sort((a, b) => a.url.localeCompare(b.url));
    const ev = row(
      canonicalJson({ page: capture.finalUrl, pass: 'A', fonts }),
      `web fonts fetched from other hosts on the first load of ${own}`,
    );
    observe(
      'third_party_fonts',
      'fail',
      `${own} fetches ${fonts.length} web font file(s) from ${fontHosts.length} other host(s), so every visitor's address reaches them: ${fontHosts.join(', ')}.`,
      { fonts },
      fontHosts,
      [ev],
    );
  } else {
    observe(
      'third_party_fonts',
      'pass',
      `${own} serves its fonts itself, or uses none.`,
      {},
      [],
      [],
    );
  }
  return { observations, evidence };
}
