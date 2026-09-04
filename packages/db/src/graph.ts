import { and, eq, inArray } from 'drizzle-orm';
import {
  ContradictionSchema,
  GRAPH_EDGE_ENDS,
  GraphEdgeSchema,
  GraphNodeSchema,
  RegisterRowSchema,
  canonicalJson,
  sha256,
  type Contradiction,
  type EvidenceRef,
  type GraphEdge,
  type GraphEdgeKind,
  type GraphNode,
  type GraphNodeKind,
  type GraphOrigin,
  type RegisterRow,
} from '@gc/contracts';
import type { Db } from './client.js';
import { graphEdges, graphNodes } from './schema.js';

// The case graph (A-01): typed nodes and edges with provenance, contradictions kept and
// surfaced, and the processing register as a projection that stores nothing.

type NodeRow = typeof graphNodes.$inferSelect;
type EdgeRow = typeof graphEdges.$inferSelect;

const toNode = (r: NodeRow): GraphNode =>
  GraphNodeSchema.parse({
    id: r.id,
    tenantId: r.tenantId,
    caseId: r.caseId,
    kind: r.kind,
    key: r.key,
    attributes: r.attributes,
    origin: r.origin,
    confidence: r.confidence,
    sourceRef: r.sourceRef,
    evidence: r.evidence,
    ...(r.assertedBy ? { assertedBy: r.assertedBy } : {}),
    ...(r.answerId ? { answerId: r.answerId } : {}),
    at: r.at.toISOString(),
    ...(r.supersededBy ? { supersededBy: r.supersededBy } : {}),
  });

const toEdge = (r: EdgeRow): GraphEdge =>
  GraphEdgeSchema.parse({
    id: r.id,
    tenantId: r.tenantId,
    caseId: r.caseId,
    kind: r.kind,
    from: r.fromNode,
    to: r.toNode,
    attributes: r.attributes,
    origin: r.origin,
    confidence: r.confidence,
    sourceRef: r.sourceRef,
    evidence: r.evidence,
    ...(r.assertedBy ? { assertedBy: r.assertedBy } : {}),
    ...(r.answerId ? { answerId: r.answerId } : {}),
    at: r.at.toISOString(),
  });

export interface FactInput {
  readonly tenantId: string;
  readonly caseId: string;
  readonly kind: GraphNodeKind;
  readonly key: string;
  readonly attributes?: Record<string, unknown>;
  readonly origin: GraphOrigin;
  readonly confidence: number;
  readonly sourceRef: string;
  readonly evidence?: readonly EvidenceRef[];
  readonly assertedBy?: string;
  readonly answerId?: string;
  readonly at: Date;
}

// A node's id is a function of what it says and where it came from, so the same fact
// stated twice from the same source is one row.
export const nodeId = (f: FactInput): string =>
  `node:${f.kind}:${sha256(
    canonicalJson({
      caseId: f.caseId,
      kind: f.kind,
      key: f.key,
      attributes: f.attributes ?? {},
      origin: f.origin,
      sourceRef: f.sourceRef,
    }),
  ).slice(0, 16)}`;

const fields = (a: Record<string, unknown>, b: Record<string, unknown>): string[] =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((k) => canonicalJson(a[k] ?? null) !== canonicalJson(b[k] ?? null))
    .sort();

export interface AssertedFact {
  readonly node: GraphNode;
  readonly inserted: boolean;
  // Contradiction edges raised against nodes that say something else about the key.
  readonly contradictions: GraphEdge[];
}

// State a fact. If the graph already holds a live node with the same kind and key that
// says something different, both stay and a contradiction edge joins them: the graph
// never picks one on its own.
export async function assertFact(db: Db, f: FactInput): Promise<AssertedFact> {
  const node = GraphNodeSchema.parse({
    id: nodeId(f),
    tenantId: f.tenantId,
    caseId: f.caseId,
    kind: f.kind,
    key: f.key,
    attributes: f.attributes ?? {},
    origin: f.origin,
    confidence: f.confidence,
    sourceRef: f.sourceRef,
    evidence: f.evidence ?? [],
    ...(f.assertedBy ? { assertedBy: f.assertedBy } : {}),
    ...(f.answerId ? { answerId: f.answerId } : {}),
    at: f.at.toISOString(),
  });
  const existing = await db
    .select()
    .from(graphNodes)
    .where(
      and(eq(graphNodes.caseId, f.caseId), eq(graphNodes.kind, f.kind), eq(graphNodes.key, f.key)),
    );
  if (existing.some((r) => r.id === node.id)) {
    return {
      node: toNode(existing.find((r) => r.id === node.id)!),
      inserted: false,
      contradictions: [],
    };
  }
  await db.insert(graphNodes).values({
    id: node.id,
    tenantId: node.tenantId,
    sourceRef: node.sourceRef,
    caseId: node.caseId,
    kind: node.kind,
    key: node.key,
    attributes: node.attributes,
    origin: node.origin,
    confidence: node.confidence,
    evidence: node.evidence,
    assertedBy: node.assertedBy ?? null,
    answerId: node.answerId ?? null,
    at: f.at,
    supersededBy: null,
  });
  const contradictions: GraphEdge[] = [];
  for (const other of existing) {
    if (other.supersededBy) continue;
    const differing = fields(other.attributes as Record<string, unknown>, node.attributes);
    if (differing.length === 0) continue;
    const edge = await addEdge(db, {
      tenantId: f.tenantId,
      caseId: f.caseId,
      kind: 'contradicts',
      from: node.id,
      to: other.id,
      attributes: { fields: differing },
      origin: 'derived',
      confidence: 1,
      sourceRef: 'graph:contradiction',
      evidence: [...node.evidence, ...(other.evidence as EvidenceRef[])],
      at: f.at,
    });
    contradictions.push(edge);
  }
  return { node, inserted: true, contradictions };
}

export interface EdgeInput {
  readonly tenantId: string;
  readonly caseId: string;
  readonly kind: GraphEdgeKind;
  readonly from: string;
  readonly to: string;
  readonly attributes?: Record<string, unknown>;
  readonly origin: GraphOrigin;
  readonly confidence: number;
  readonly sourceRef: string;
  readonly evidence?: readonly EvidenceRef[];
  readonly assertedBy?: string;
  readonly answerId?: string;
  readonly at: Date;
}

export class GraphEdgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphEdgeError';
  }
}

export const edgeId = (e: EdgeInput): string =>
  `edge:${e.kind}:${sha256(canonicalJson({ caseId: e.caseId, kind: e.kind, from: e.from, to: e.to })).slice(0, 16)}`;

// Join two nodes. The ends must be of the kinds the edge kind joins, in this case; a
// contradiction edge between nodes of different subjects is refused.
export async function addEdge(db: Db, e: EdgeInput): Promise<GraphEdge> {
  const ends = await db
    .select()
    .from(graphNodes)
    .where(and(eq(graphNodes.caseId, e.caseId), inArray(graphNodes.id, [e.from, e.to])));
  const from = ends.find((n) => n.id === e.from);
  const to = ends.find((n) => n.id === e.to);
  if (!from || !to) throw new GraphEdgeError(`${e.kind}: both ends must exist on case ${e.caseId}`);
  const [wantFrom, wantTo] = GRAPH_EDGE_ENDS[e.kind];
  if (wantFrom !== '*' && from.kind !== wantFrom)
    throw new GraphEdgeError(`${e.kind} starts at a ${wantFrom}, not a ${from.kind}`);
  if (wantTo !== '*' && to.kind !== wantTo)
    throw new GraphEdgeError(`${e.kind} ends at a ${wantTo}, not a ${to.kind}`);
  if (
    (e.kind === 'contradicts' || e.kind === 'supersedes') &&
    (from.kind !== to.kind || from.key !== to.key)
  )
    throw new GraphEdgeError(`${e.kind} joins two statements about one subject`);
  const edge = GraphEdgeSchema.parse({
    id: edgeId(e),
    tenantId: e.tenantId,
    caseId: e.caseId,
    kind: e.kind,
    from: e.from,
    to: e.to,
    attributes: e.attributes ?? {},
    origin: e.origin,
    confidence: e.confidence,
    sourceRef: e.sourceRef,
    evidence: e.evidence ?? [],
    ...(e.assertedBy ? { assertedBy: e.assertedBy } : {}),
    ...(e.answerId ? { answerId: e.answerId } : {}),
    at: e.at.toISOString(),
  });
  await db
    .insert(graphEdges)
    .values({
      id: edge.id,
      tenantId: edge.tenantId,
      sourceRef: edge.sourceRef,
      caseId: edge.caseId,
      kind: edge.kind,
      fromNode: edge.from,
      toNode: edge.to,
      attributes: edge.attributes,
      origin: edge.origin,
      confidence: edge.confidence,
      evidence: edge.evidence,
      assertedBy: edge.assertedBy ?? null,
      answerId: edge.answerId ?? null,
      at: e.at,
    })
    .onConflictDoNothing();
  return edge;
}

export interface CaseGraph {
  readonly nodes: GraphNode[];
  readonly edges: GraphEdge[];
}

export async function graphOf(db: Db, caseId: string): Promise<CaseGraph> {
  const [n, e] = await Promise.all([
    db.select().from(graphNodes).where(eq(graphNodes.caseId, caseId)),
    db.select().from(graphEdges).where(eq(graphEdges.caseId, caseId)),
  ]);
  return {
    nodes: n.map(toNode).sort((a, b) => a.id.localeCompare(b.id)),
    edges: e.map(toEdge).sort((a, b) => a.id.localeCompare(b.id)),
  };
}

// Every contradiction on the case, resolved or not, newest first.
export async function contradictions(db: Db, caseId: string): Promise<Contradiction[]> {
  const g = await graphOf(db, caseId);
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  return g.edges
    .filter((e) => e.kind === 'contradicts')
    .map((e) => {
      const a = byId.get(e.from)!;
      const b = byId.get(e.to)!;
      const resolved = e.attributes['resolved'] as Contradiction['resolved'] | undefined;
      return ContradictionSchema.parse({
        edgeId: e.id,
        caseId,
        kind: a.kind,
        key: a.key,
        a,
        b,
        fields: (e.attributes['fields'] as string[]) ?? [],
        ...(resolved ? { resolved } : {}),
      });
    })
    .sort((x, y) => y.a.at.localeCompare(x.a.at));
}

export const openContradictions = async (db: Db, caseId: string): Promise<Contradiction[]> =>
  (await contradictions(db, caseId)).filter((c) => !c.resolved);

// A person decides which statement stands. The other is marked superseded, the edge
// records who decided and when, and nothing is deleted.
export async function resolveContradiction(
  db: Db,
  input: { caseId: string; edgeId: string; keep: string; by: string; at: Date },
): Promise<Contradiction> {
  const [edge] = await db
    .select()
    .from(graphEdges)
    .where(and(eq(graphEdges.caseId, input.caseId), eq(graphEdges.id, input.edgeId)));
  if (!edge || edge.kind !== 'contradicts')
    throw new GraphEdgeError(`no contradiction ${input.edgeId}`);
  if (input.keep !== edge.fromNode && input.keep !== edge.toNode)
    throw new GraphEdgeError(`${input.keep} is not a side of ${input.edgeId}`);
  const loser = input.keep === edge.fromNode ? edge.toNode : edge.fromNode;
  const resolved = { kept: input.keep, by: input.by, at: input.at.toISOString() };
  await db
    .update(graphEdges)
    .set({ attributes: { ...(edge.attributes as Record<string, unknown>), resolved } })
    .where(eq(graphEdges.id, edge.id));
  await db.update(graphNodes).set({ supersededBy: input.keep }).where(eq(graphNodes.id, loser));
  await addEdge(db, {
    tenantId: edge.tenantId,
    caseId: input.caseId,
    kind: 'supersedes',
    from: input.keep,
    to: loser,
    origin: 'asserted',
    confidence: 1,
    sourceRef: `person:${input.by}`,
    assertedBy: input.by,
    at: input.at,
  });
  const all = await contradictions(db, input.caseId);
  return all.find((c) => c.edgeId === input.edgeId)!;
}

const ORIGIN_RANK: Record<GraphOrigin, number> = { derived: 0, asserted: 1, answered: 2 };
const weakest = (origins: GraphOrigin[]): GraphOrigin =>
  origins.reduce((w, o) => (ORIGIN_RANK[o] < ORIGIN_RANK[w] ? o : w), 'answered' as GraphOrigin);

const label = (n: GraphNode): string =>
  typeof n.attributes['name'] === 'string' ? (n.attributes['name'] as string) : n.key;

// The processing register, read off the graph. Superseded nodes are left out; a
// contradiction still open counts against the row.
export async function registerProjection(db: Db, caseId: string): Promise<RegisterRow[]> {
  const g = await graphOf(db, caseId);
  const live = new Map(g.nodes.filter((n) => !n.supersededBy).map((n) => [n.id, n]));
  const out = (from: string, kind: GraphEdgeKind): { node: GraphNode; edge: GraphEdge }[] =>
    g.edges
      .filter((e) => e.kind === kind && e.from === from && live.has(e.to))
      .map((e) => ({ node: live.get(e.to)!, edge: e }));
  const open = await openContradictions(db, caseId);
  const rows: RegisterRow[] = [];
  for (const activity of [...live.values()].filter((n) => n.kind === 'activity')) {
    const purposes = out(activity.id, 'has_purpose');
    const categories = out(activity.id, 'processes');
    const bases = out(activity.id, 'rests_on');
    const vendors = out(activity.id, 'shared_with');
    const transfers = vendors.flatMap((v) =>
      out(v.node.id, 'transfers_via').map((t) => ({ vendor: v.node, ...t })),
    );
    const risks = out(activity.id, 'carries_risk');
    const controls = risks.flatMap((r) => out(r.node.id, 'mitigated_by'));
    const parts = [
      activity,
      ...[...purposes, ...categories, ...bases, ...vendors, ...risks, ...controls].flatMap((p) => [
        p.node,
        p.edge,
      ]),
      ...transfers.flatMap((t) => [t.node, t.edge]),
    ];
    const involved = new Set(parts.map((p) => p.id));
    const evidence = [
      ...new Map(parts.flatMap((p) => p.evidence).map((r) => [r.evidenceId, r])).values(),
    ];
    rows.push(
      RegisterRowSchema.parse({
        activityId: activity.id,
        key: activity.key,
        name: label(activity),
        attributes: activity.attributes,
        purposes: purposes.map((p) => label(p.node)),
        dataCategories: categories.map((c) => label(c.node)),
        legalBases: bases.map((b) => label(b.node)),
        recipients: vendors.map((v) => ({
          nodeId: v.node.id,
          name: label(v.node),
          ...(typeof v.node.attributes['country'] === 'string'
            ? { country: v.node.attributes['country'] as string }
            : {}),
        })),
        transfers: transfers.map((t) => ({
          nodeId: t.node.id,
          vendor: label(t.vendor),
          attributes: t.node.attributes,
        })),
        risks: risks.map((r) => label(r.node)),
        controls: controls.map((c) => label(c.node)),
        origin: weakest(parts.map((p) => p.origin)),
        confidence: Math.min(...parts.map((p) => p.confidence)),
        evidence,
        draft: parts.some((p) => p.origin !== 'answered'),
        contradictions: open.filter((c) => involved.has(c.a.id) || involved.has(c.b.id)).length,
      }),
    );
  }
  return rows.sort((a, b) => a.key.localeCompare(b.key));
}
