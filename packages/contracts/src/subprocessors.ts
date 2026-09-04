import { z } from 'zod';
import { EvidenceRefSchema } from './evidence.js';
import {
  CountryCodeSchema,
  HostnameSchema,
  IsoDateTimeSchema,
  NonEmptyStringSchema,
  UrlSchema,
} from './primitives.js';

// Sub-processor lists and the supply chain they describe (D-07). A processor names the
// companies it hands the data on to; each of those may publish a list of its own. The
// chain is walked breadth first from the supplier the case knows, to a depth and a
// size that are limits, not hopes: both are enforced and both are recorded when they
// stop the walk. Every edge carries the document it was read from and the day it was
// read, so a chain can be shown to a customer and re-read when the list changes.
// Vendors reference each other, so a node is visited once and a repeat is a cycle,
// kept as an edge and never followed. Nothing here says a named company is lawful to
// use; the chain is what the lists say.

export const SubProcessorEntrySchema = z.object({
  // The company as the list names it, verbatim.
  name: NonEmptyStringSchema,
  // The site the list links or names for it, when it does; followed if within limits.
  host: HostnameSchema.optional(),
  country: CountryCodeSchema.optional(),
  // What the list says it is for, in the list's own words, when it says.
  purpose: z.string().optional(),
  // The line of the list the entry was read from, verbatim.
  quote: NonEmptyStringSchema,
});
export type SubProcessorEntry = z.infer<typeof SubProcessorEntrySchema>;

export const SubProcessorListSchema = z.object({
  vendor: z.object({ host: HostnameSchema, name: z.string().optional() }),
  url: UrlSchema,
  finalUrl: UrlSchema,
  title: z.string().optional(),
  fetchedAt: IsoDateTimeSchema,
  foundBy: z.enum(['link', 'well-known']),
  evidence: EvidenceRefSchema,
  entries: z.array(SubProcessorEntrySchema),
});
export type SubProcessorList = z.infer<typeof SubProcessorListSchema>;

export const SUPPLY_CHAIN_SKIPS = [
  'robots',
  'unreachable',
  'no_list',
  'no_site',
  'depth',
  'nodes',
] as const;
export const SupplyChainSkipSchema = z.enum(SUPPLY_CHAIN_SKIPS);
export type SupplyChainSkip = z.infer<typeof SupplyChainSkipSchema>;

export const SupplyChainNodeSchema = z.object({
  // The host, or for a company the list names without a site, name:<slug>.
  id: NonEmptyStringSchema,
  name: NonEmptyStringSchema,
  host: HostnameSchema.optional(),
  country: CountryCodeSchema.optional(),
  // 0 is the supplier the walk started from; its sub-processors are 1, theirs 2.
  depth: z.number().int().min(0),
  // Whether this node's own list was read, and if not, why not.
  list: z.enum(['read', 'skipped']),
  skipped: SupplyChainSkipSchema.optional(),
});
export type SupplyChainNode = z.infer<typeof SupplyChainNodeSchema>;

export const SupplyChainEdgeSchema = z.object({
  from: NonEmptyStringSchema,
  to: NonEmptyStringSchema,
  // The list the edge was read from: where, when, and the stored page.
  document: z.object({
    url: UrlSchema,
    fetchedAt: IsoDateTimeSchema,
    evidence: EvidenceRefSchema,
  }),
  entry: SubProcessorEntrySchema,
  // An edge to a node already on the chain: kept, never followed.
  cycle: z.boolean(),
});
export type SupplyChainEdge = z.infer<typeof SupplyChainEdgeSchema>;

export const SupplyChainLimitsSchema = z.object({
  maxDepth: z.number().int().min(0),
  maxNodes: z.number().int().min(1),
  minIntervalMs: z.number().int().min(0),
  respectRobots: z.boolean(),
});
export type SupplyChainLimits = z.infer<typeof SupplyChainLimitsSchema>;

export const SupplyChainSchema = z
  .object({
    root: NonEmptyStringSchema,
    startedAt: IsoDateTimeSchema,
    finishedAt: IsoDateTimeSchema,
    limits: SupplyChainLimitsSchema,
    nodes: z.array(SupplyChainNodeSchema).min(1),
    edges: z.array(SupplyChainEdgeSchema),
    // Which limit stopped the walk, when one did.
    stoppedBy: z.enum(['depth', 'nodes']).optional(),
    // Companies a list named that the node cap left off the chain.
    dropped: z.number().int().min(0).default(0),
    // Every request the walk made, in order: the politeness record.
    requests: z.array(z.object({ host: HostnameSchema, url: UrlSchema, at: IsoDateTimeSchema })),
  })
  .superRefine((c, ctx) => {
    const ids = new Set<string>();
    c.nodes.forEach((n, i) => {
      if (ids.has(n.id))
        ctx.addIssue({ code: 'custom', path: ['nodes', i], message: `${n.id} twice` });
      ids.add(n.id);
      if (n.depth > c.limits.maxDepth)
        ctx.addIssue({
          code: 'custom',
          path: ['nodes', i],
          message: `${n.id} is beyond the depth cap`,
        });
      if ((n.list === 'skipped') !== (n.skipped !== undefined))
        ctx.addIssue({ code: 'custom', path: ['nodes', i], message: 'a skipped list says why' });
    });
    if (c.nodes.length > c.limits.maxNodes)
      ctx.addIssue({ code: 'custom', path: ['nodes'], message: 'more nodes than the cap allows' });
    c.edges.forEach((e, i) => {
      if (!ids.has(e.from) || !ids.has(e.to))
        ctx.addIssue({
          code: 'custom',
          path: ['edges', i],
          message: 'an edge joins two nodes on the chain',
        });
    });
    if (c.nodes[0]?.id !== c.root)
      ctx.addIssue({ code: 'custom', path: ['nodes'], message: 'the root comes first' });
  })
  .describe("A supplier's sub-processors, and theirs, as their published lists say");
export type SupplyChain = z.infer<typeof SupplyChainSchema>;
