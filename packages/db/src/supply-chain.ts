import { and, eq } from 'drizzle-orm';
import type { EvidenceRef, GraphEdge, GraphNode, SupplyChain } from '@gc/contracts';
import { type HostResolver, noResolver } from './drift.js';
import { addEdge, assertFact, graphOf } from './graph.js';
import { graphEdges } from './schema.js';
import type { Connection, Db } from './client.js';
import { withTenant } from './tenant.js';

// The supply chain on the case graph (D-07): every company a walk along the published
// sub-processor lists found is a vendor node, and every list entry an `engages` edge
// from the company that published the list to the company it named. The edge carries
// the page it was read from and the moment it was read; a cycle is an edge like any
// other, marked as one. A host the registry knows is keyed by its registry id, so it
// merges with the vendor the register already holds; anything else is keyed by host,
// or by name when the list gave no site. Nothing here says a company is lawful to use.

export interface SeedSupplyChainInput {
  readonly chain: SupplyChain;
  readonly scanId: string;
  readonly now: Date;
  readonly resolve?: HostResolver;
}

export interface SeedSupplyChainResult {
  readonly nodes: number;
  readonly edges: number;
  // Node id on the chain to node id on the graph.
  readonly nodeIds: ReadonlyMap<string, string>;
}

export async function seedSupplyChain(
  connection: Connection,
  tenantId: string,
  caseId: string,
  input: SeedSupplyChainInput,
): Promise<SeedSupplyChainResult> {
  const resolve = input.resolve ?? noResolver;
  const sourceRef = `scanner:${input.scanId}:supply-chain`;
  return withTenant(connection, tenantId, async (db) => {
    let inserted = 0;
    let edges = 0;
    const nodeIds = new Map<string, string>();
    // What names each node: the lists that carry an edge into it; the root, its own list.
    const evidenceFor = new Map<string, EvidenceRef[]>();
    for (const e of input.chain.edges) {
      const refs = evidenceFor.get(e.to) ?? [];
      if (!refs.some((r) => r.evidenceId === e.document.evidence.evidenceId))
        refs.push(e.document.evidence);
      evidenceFor.set(e.to, refs);
    }
    const rootList = input.chain.edges.find((e) => e.from === input.chain.root)?.document.evidence;
    if (rootList) evidenceFor.set(input.chain.root, [rootList]);

    for (const n of input.chain.nodes) {
      const evidence = evidenceFor.get(n.id) ?? [];
      // A node nothing points at and that published nothing is a bare name; the graph
      // refuses a derived fact without evidence, and rightly.
      if (evidence.length === 0) continue;
      const resolved = n.host ? resolve(n.host) : { resolution: 'unresolved' as const };
      const key =
        resolved.resolution === 'resolved'
          ? `vendor:${resolved.entry.id}`
          : n.host
            ? `vendor:host:${n.host}`
            : `vendor:name:${n.id.replace(/^name:/, '')}`;
      const attributes: Record<string, unknown> =
        resolved.resolution === 'resolved'
          ? {
              name: resolved.entry.contracting.name,
              country: resolved.entry.contracting.country,
              parent: resolved.entry.parent.name,
              parentCountry: resolved.entry.parent.country,
              ...(n.host ? { hosts: [n.host] } : {}),
            }
          : {
              name: n.name,
              ...(n.country ? { country: n.country } : {}),
              ...(n.host ? { hosts: [n.host] } : {}),
              unresolved: true,
            };
      const r = await assertFact(db, {
        tenantId,
        caseId,
        kind: 'vendor',
        key,
        attributes: { ...attributes, level: n.depth + 1 },
        origin: 'derived',
        confidence: resolved.resolution === 'resolved' ? 0.7 : 0.5,
        sourceRef,
        evidence,
        at: input.now,
      });
      if (r.inserted) inserted += 1;
      nodeIds.set(n.id, r.node.id);
    }

    for (const e of input.chain.edges) {
      const from = nodeIds.get(e.from);
      const to = nodeIds.get(e.to);
      if (!from || !to) continue;
      await addEdge(db, {
        tenantId,
        caseId,
        kind: 'engages',
        from,
        to,
        attributes: {
          document: e.document.url,
          fetchedAt: e.document.fetchedAt,
          quote: e.entry.quote,
          ...(e.entry.purpose ? { purpose: e.entry.purpose } : {}),
          cycle: e.cycle,
        },
        origin: 'derived',
        confidence: 0.6,
        sourceRef,
        evidence: [e.document.evidence],
        at: input.now,
      });
      edges += 1;
    }
    return { nodes: inserted, edges, nodeIds };
  });
}

export interface SupplyChainRow {
  readonly from: GraphNode;
  readonly to: GraphNode;
  readonly edge: GraphEdge;
}

// The chain as the graph holds it: every engages edge with both ends, oldest first.
export async function supplyChainOf(db: Db, caseId: string): Promise<SupplyChainRow[]> {
  const graph = await graphOf(db, caseId);
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const rows = await db
    .select()
    .from(graphEdges)
    .where(and(eq(graphEdges.caseId, caseId), eq(graphEdges.kind, 'engages')));
  return rows
    .map((r) => graph.edges.find((e) => e.id === r.id))
    .filter((e): e is GraphEdge => e !== undefined)
    .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
    .flatMap((edge) => {
      const from = nodes.get(edge.from);
      const to = nodes.get(edge.to);
      return from && to ? [{ from, to, edge }] : [];
    });
}
