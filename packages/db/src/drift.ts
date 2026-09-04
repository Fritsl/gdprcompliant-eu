import { and, desc, eq } from 'drizzle-orm';
import { tracesOf } from '@gc/artefacts';
import {
  EvidenceSchema,
  canonicalJson,
  sha256,
  type Evidence,
  type EvidenceRef,
  type RecipientObservation,
  type VendorRegistryEntry,
} from '@gc/contracts';
import type { AssemblyDraft } from '@gc/findings';
import type { Connection, Db } from './client.js';
import { graphOf } from './graph.js';
import { artefacts } from './schema.js';
import { withTenant } from './tenant.js';

// The drift check (G-05): the published privacy policy against what the crawler sees.
// The policy's trace comments name the vendor rows it was written from; the watch run's
// recipients read names every third-party host the first load contacted. A host whose
// company the policy does not name is drift. The finding rests on an evidence row that
// says both sides, what the policy names and what the site does, so the two stay
// readable after either changes. Markup that changes without a new host is not drift,
// because only hosts are compared.

export const DRIFT_FINDING = 'POL-05' as const;

// Host to registry entry, as the scanner's resolver does it; passed in, so the database
// package needs no browser. Without one, every host is its own name.
export type HostResolver = (
  host: string,
) =>
  | { readonly resolution: 'resolved'; readonly entry: VendorRegistryEntry }
  | { readonly resolution: 'unresolved' | 'ambiguous' };

export const noResolver: HostResolver = () => ({ resolution: 'unresolved' });

export interface NamedRecipient {
  readonly nodeId: string;
  readonly key: string;
  readonly name: string;
  readonly hosts: readonly string[];
}

export interface UnnamedHost {
  readonly host: string;
  // The registry's entry, when the host resolves to one; the raw host otherwise.
  readonly vendor?: { readonly id: string; readonly name: string };
}

export interface DriftReport {
  readonly policy?: { readonly id: string; readonly version: number; readonly hash: string };
  readonly named: readonly NamedRecipient[];
  readonly observed: readonly string[];
  readonly unnamed: readonly UnnamedHost[];
  // The recipients read the comparison rests on.
  readonly evidence: readonly EvidenceRef[];
}

const endsWithHost = (host: string, suffix: string) =>
  host === suffix || host.endsWith(`.${suffix}`);

async function publishedPolicy(db: Db, caseId: string) {
  const [row] = await db
    .select()
    .from(artefacts)
    .where(
      and(
        eq(artefacts.caseId, caseId),
        eq(artefacts.kind, 'privacy_policy'),
        eq(artefacts.status, 'published'),
      ),
    )
    .orderBy(desc(artefacts.version))
    .limit(1);
  return row;
}

// The recipients the published policy names: the vendor nodes its traces point at.
export async function namedRecipients(
  db: Db,
  caseId: string,
): Promise<{ policy?: DriftReport['policy']; named: NamedRecipient[] }> {
  const policy = await publishedPolicy(db, caseId);
  if (!policy) return { named: [] };
  const ids = new Set(tracesOf(policy.content).flat());
  const g = await graphOf(db, caseId);
  const named = g.nodes
    .filter((n) => n.kind === 'vendor' && ids.has(n.id))
    .map((n) => ({
      nodeId: n.id,
      key: n.key,
      name: typeof n.attributes['name'] === 'string' ? (n.attributes['name'] as string) : n.key,
      hosts: Array.isArray(n.attributes['hosts']) ? (n.attributes['hosts'] as string[]) : [],
    }));
  return { policy: { id: policy.id, version: policy.version, hash: policy.hash }, named };
}

// Compare what the site contacted with what the policy names.
export function compareRecipients(
  named: readonly NamedRecipient[],
  observations: readonly RecipientObservation[],
  resolve: HostResolver = noResolver,
): Pick<DriftReport, 'observed' | 'unnamed' | 'evidence'> {
  const transfers = observations.find((o) => o.check === 'transfers');
  const observed = [
    ...new Set(
      ((transfers?.detail['thirdParty'] as string[] | undefined) ?? []).map((h) => h.toLowerCase()),
    ),
  ].sort();
  const unnamed: UnnamedHost[] = [];
  for (const host of observed) {
    const r = resolve(host);
    const vendorKey = r.resolution === 'resolved' ? `vendor:${r.entry.id}` : undefined;
    const isNamed = named.some(
      (n) =>
        (vendorKey !== undefined && n.key === vendorKey) ||
        n.hosts.some(
          (h) => endsWithHost(host, h.toLowerCase()) || endsWithHost(h.toLowerCase(), host),
        ),
    );
    if (isNamed) continue;
    unnamed.push({
      host,
      ...(r.resolution === 'resolved'
        ? { vendor: { id: r.entry.id, name: r.entry.contracting.name } }
        : {}),
    });
  }
  return { observed, unnamed, evidence: transfers?.evidence ?? [] };
}

export async function policyDrift(
  connection: Connection,
  tenantId: string,
  caseId: string,
  observations: readonly RecipientObservation[],
  resolve: HostResolver = noResolver,
): Promise<DriftReport> {
  return withTenant(connection, tenantId, async (db) => {
    const { policy, named } = await namedRecipients(db, caseId);
    if (!policy) return { named, observed: [], unnamed: [], evidence: [] };
    const cmp = compareRecipients(named, observations, resolve);
    return { policy, named, ...cmp };
  });
}

export const describeSides = (report: DriftReport): { policy: string; site: string } => ({
  policy: report.named.length === 0 ? 'no recipient' : report.named.map((n) => n.name).join(', '),
  site: report.unnamed.map((u) => (u.vendor ? `${u.host} (${u.vendor.name})` : u.host)).join(', '),
});

export interface DriftIdentity {
  readonly tenantId: string;
  readonly caseId: string;
  readonly scanId: string;
  readonly capturedAt: string;
  readonly host: string;
}

// Both sides as one evidence row: what the policy names, what the site does.
export function driftEvidence(report: DriftReport, identity: DriftIdentity): Evidence | undefined {
  if (!report.policy || report.unnamed.length === 0) return undefined;
  const sides = describeSides(report);
  const body = canonicalJson({
    policy: {
      id: report.policy.id,
      version: report.policy.version,
      hash: report.policy.hash,
      names: report.named.map((n) => ({ name: n.name, hosts: n.hosts })),
    },
    site: { contacts: report.observed, unnamed: report.unnamed },
  });
  const hash = sha256(body);
  return EvidenceSchema.parse({
    id: `text:${hash.slice(0, 16)}`,
    tenantId: identity.tenantId,
    caseId: identity.caseId,
    scanId: identity.scanId,
    kind: 'text',
    capturedAt: identity.capturedAt,
    source: { url: `https://${identity.host}/`, host: identity.host },
    body,
    hash,
    caption: `The published privacy policy (version ${report.policy.version}) names ${sides.policy}; the site sends visitors' requests to ${sides.site}, which it does not name.`,
  });
}

// One finding, on the read and on the row that names both sides. Nothing without a
// published policy, and nothing without the evidence the read produced.
export function driftDrafts(
  report: DriftReport,
  sides: Evidence | undefined,
  host: string,
): AssemblyDraft[] {
  if (!report.policy || report.unnamed.length === 0 || report.evidence.length === 0) return [];
  const s = describeSides(report);
  return [
    {
      typeId: DRIFT_FINDING,
      subject: { host },
      evidence: [
        ...report.evidence,
        ...(sides ? [{ evidenceId: sides.id, hash: sides.hash }] : []),
      ],
      hosts: report.unnamed.map((u) => u.host),
      summary: `The published privacy policy (version ${report.policy.version}) names ${s.policy}. The site now sends visitors' requests to ${s.site}, which the policy does not name.`,
    },
  ];
}
