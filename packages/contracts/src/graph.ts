import { z } from 'zod';
import { EvidenceRefSchema } from './evidence.js';
import {
  CaseIdSchema,
  IdSchema,
  IsoDateTimeSchema,
  NonEmptyStringSchema,
  TenantIdSchema,
} from './primitives.js';

// The case graph (A-01). Activities, data categories, purposes, legal bases, vendors,
// transfers, risks and controls are nodes; what relates them are edges. Every node and
// edge says where it came from (derived by code from evidence, asserted by a person,
// or answered to a question), how sure it is, and when. Two nodes that say different
// things about the same subject both stay, joined by a contradiction edge, until a
// person resolves it; nothing is resolved silently. The processing register (G-01) is
// read off this graph and stored nowhere else.

export const GRAPH_NODE_KINDS = [
  'activity',
  'data_category',
  'purpose',
  'legal_basis',
  'vendor',
  'transfer',
  'risk',
  'control',
] as const;
export const GraphNodeKindSchema = z.enum(GRAPH_NODE_KINDS);
export type GraphNodeKind = z.infer<typeof GraphNodeKindSchema>;

export const GRAPH_EDGE_KINDS = [
  'has_purpose', // activity → purpose
  'processes', // activity → data_category
  'rests_on', // activity → legal_basis
  'shared_with', // activity → vendor
  'transfers_via', // vendor → transfer
  'engages', // vendor → vendor: a sub-processor named on the vendor's list (D-07)
  'carries_risk', // activity → risk
  'mitigated_by', // risk → control
  'contradicts', // node → node of the same kind and key
  'supersedes', // node → node of the same kind and key
] as const;
export const GraphEdgeKindSchema = z.enum(GRAPH_EDGE_KINDS);
export type GraphEdgeKind = z.infer<typeof GraphEdgeKindSchema>;

// Which kinds an edge may join. A contradiction or a supersession joins two nodes of
// one kind; the rest are fixed pairs.
export const GRAPH_EDGE_ENDS: Record<
  GraphEdgeKind,
  readonly [GraphNodeKind | '*', GraphNodeKind | '*']
> = {
  has_purpose: ['activity', 'purpose'],
  processes: ['activity', 'data_category'],
  rests_on: ['activity', 'legal_basis'],
  shared_with: ['activity', 'vendor'],
  transfers_via: ['vendor', 'transfer'],
  engages: ['vendor', 'vendor'],
  carries_risk: ['activity', 'risk'],
  mitigated_by: ['risk', 'control'],
  contradicts: ['*', '*'],
  supersedes: ['*', '*'],
};

export const GRAPH_ORIGINS = ['derived', 'asserted', 'answered'] as const;
export const GraphOriginSchema = z.enum(GRAPH_ORIGINS);
export type GraphOrigin = z.infer<typeof GraphOriginSchema>;

// The provenance every node and edge carries. Derived facts point at evidence;
// asserted facts name who said so; answered facts name the answer.
const provenance = {
  origin: GraphOriginSchema,
  confidence: z.number().min(0).max(1),
  sourceRef: NonEmptyStringSchema,
  evidence: z.array(EvidenceRefSchema).default([]),
  assertedBy: z.string().optional(),
  answerId: z.string().optional(),
  at: IsoDateTimeSchema,
};

function provenanceRules(
  v: {
    origin: GraphOrigin;
    evidence: unknown[];
    assertedBy?: string | undefined;
    answerId?: string | undefined;
  },
  ctx: z.RefinementCtx,
) {
  if (v.origin === 'derived' && v.evidence.length === 0)
    ctx.addIssue({
      code: 'custom',
      path: ['evidence'],
      message: 'a derived fact points at evidence',
    });
  if (v.origin === 'asserted' && !v.assertedBy)
    ctx.addIssue({
      code: 'custom',
      path: ['assertedBy'],
      message: 'an asserted fact names who asserted it',
    });
  if (v.origin === 'answered' && !v.answerId)
    ctx.addIssue({
      code: 'custom',
      path: ['answerId'],
      message: 'an answered fact names the answer',
    });
}

export const GraphNodeSchema = z
  .object({
    id: IdSchema,
    tenantId: TenantIdSchema,
    caseId: CaseIdSchema,
    kind: GraphNodeKindSchema,
    // The subject the node is about, stable across restatements: 'activity:newsletter',
    // 'vendor:google'. Two nodes with one key say something about the same subject.
    key: NonEmptyStringSchema,
    attributes: z.record(z.string(), z.unknown()).default({}),
    ...provenance,
    // Set when a person resolved a contradiction against this node.
    supersededBy: IdSchema.optional(),
  })
  .superRefine(provenanceRules);
export type GraphNode = z.infer<typeof GraphNodeSchema>;

export const GraphEdgeSchema = z
  .object({
    id: IdSchema,
    tenantId: TenantIdSchema,
    caseId: CaseIdSchema,
    kind: GraphEdgeKindSchema,
    from: IdSchema,
    to: IdSchema,
    attributes: z.record(z.string(), z.unknown()).default({}),
    ...provenance,
  })
  .superRefine(provenanceRules);
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

// A contradiction as the graph surfaces it: the two nodes, the fields on which they
// differ, and, once a person has decided, which one stands.
export const ContradictionSchema = z.object({
  edgeId: IdSchema,
  caseId: CaseIdSchema,
  kind: GraphNodeKindSchema,
  key: NonEmptyStringSchema,
  a: GraphNodeSchema,
  b: GraphNodeSchema,
  fields: z.array(z.string()),
  resolved: z
    .object({ kept: IdSchema, by: NonEmptyStringSchema, at: IsoDateTimeSchema })
    .optional(),
});
export type Contradiction = z.infer<typeof ContradictionSchema>;

// One row of the processing register, read off the graph. Nothing here is stored: it
// is the activity node with what the edges attach to it, and the weakest provenance
// among them. A row whose parts are not all answered is a draft.
export const RegisterRowSchema = z.object({
  activityId: IdSchema,
  key: NonEmptyStringSchema,
  name: NonEmptyStringSchema,
  attributes: z.record(z.string(), z.unknown()),
  purposes: z.array(z.string()),
  dataCategories: z.array(z.string()),
  legalBases: z.array(z.string()),
  recipients: z.array(
    z.object({ nodeId: IdSchema, name: z.string(), country: z.string().optional() }),
  ),
  transfers: z.array(
    z.object({
      nodeId: IdSchema,
      vendor: z.string(),
      attributes: z.record(z.string(), z.unknown()),
    }),
  ),
  risks: z.array(z.string()),
  controls: z.array(z.string()),
  // The weakest origin among the parts: derived < asserted < answered.
  origin: GraphOriginSchema,
  confidence: z.number().min(0).max(1),
  evidence: z.array(EvidenceRefSchema),
  draft: z.boolean(),
  contradictions: z.number().int().min(0),
});
export type RegisterRow = z.infer<typeof RegisterRowSchema>;
