import { z } from 'zod';
import { EvidenceRefSchema } from './evidence.js';
import { HostnameSchema, IsoDateTimeSchema } from './primitives.js';

// Certificate transparency enumeration (D-02): the hostnames a domain's certificates
// have named in public logs, classified by what the name suggests, and at most one
// safe HEAD per host to say whether it answers. Enumeration describes exposure; it
// never asserts a breach, and it never probes further.

export const HOST_CLASSES = [
  'production',
  'non_production',
  'internal_service',
  'api',
  'static',
  'commerce',
  'wildcard',
  'other',
] as const;
export const HostClassSchema = z.enum(HOST_CLASSES);
export type HostClass = z.infer<typeof HostClassSchema>;

export const CtHostSchema = z.object({
  host: z.string().min(1),
  class: HostClassSchema,
  firstSeen: IsoDateTimeSchema.optional(),
  lastSeen: IsoDateTimeSchema.optional(),
  issuers: z.array(z.string()).default([]),
  certificates: z.number().int().min(0),
  // One HEAD, if the host was among those probed: what it answered, or that it did not.
  probe: z
    .object({
      status: z.number().int().min(0),
      reachable: z.boolean(),
    })
    .optional(),
});
export type CtHost = z.infer<typeof CtHostSchema>;

export const EXPOSED_HOSTS_FINDING = 'EXP-01' as const;

export const CtEnumerationSchema = z
  .object({
    domain: HostnameSchema,
    source: z.string().min(1),
    fetchedAt: IsoDateTimeSchema,
    // Log entries read, hosts kept, and whether the cap cut the list.
    entries: z.number().int().min(0),
    hosts: z.array(CtHostSchema),
    capped: z.boolean(),
    probed: z.number().int().min(0),
    observation: z.object({
      findingTypeId: z.literal(EXPOSED_HOSTS_FINDING),
      outcome: z.enum(['pass', 'fail']),
      summary: z.string().min(1),
      evidence: z.array(EvidenceRefSchema).default([]),
    }),
    evidence: z.array(EvidenceRefSchema),
  })
  .describe('What public certificate logs name under a domain');
export type CtEnumeration = z.infer<typeof CtEnumerationSchema>;
