import { z } from 'zod';
import { EvidenceRefSchema } from './evidence.js';
import {
  CaseIdSchema,
  CountryCodeSchema,
  HostnameSchema,
  IdSchema,
  IsoDateTimeSchema,
  NonEmptyStringSchema,
  TenantIdSchema,
} from './primitives.js';

// A vendor is a recipient of personal data: a processor, a sub-processor, or a controller
// in its own right. Resolution from host to legal entity (S-07) is a data problem with
// provenance on every entry; an unresolved vendor is a first-class state, not an error.
// Nothing here characterises a vendor as lawful or unlawful (O-03) — only what was
// observed and what the registry says.

export const VENDOR_ROLES = [
  'processor',
  'sub_processor',
  'joint_controller',
  'independent_controller',
  'unknown',
] as const;
export const VendorRoleSchema = z.enum(VENDOR_ROLES);
export type VendorRole = z.infer<typeof VendorRoleSchema>;

export const VENDOR_RESOLUTIONS = ['resolved', 'unresolved', 'ambiguous'] as const;
export const VendorResolutionSchema = z.enum(VENDOR_RESOLUTIONS);
export type VendorResolution = z.infer<typeof VendorResolutionSchema>;

export const TRANSFER_MECHANISMS = ['adequacy', 'scc', 'bcr', 'dpf', 'none', 'unknown'] as const;
export const TransferMechanismSchema = z.enum(TRANSFER_MECHANISMS);
export type TransferMechanism = z.infer<typeof TransferMechanismSchema>;

export const VendorProvenanceSchema = z
  .object({
    source: z.enum(['registry', 'policy', 'contract', 'answer', 'observation']),
    registryVersion: z.string().optional(),
    seenAt: IsoDateTimeSchema,
    evidence: z.array(EvidenceRefSchema).min(1, 'a vendor entry names the evidence it came from'),
  })
  .describe('Where this vendor entry came from');
export type VendorProvenance = z.infer<typeof VendorProvenanceSchema>;

export const VendorSchema = z
  .object({
    id: IdSchema,
    tenantId: TenantIdSchema,
    caseId: CaseIdSchema,
    // What the customer sees: 'Newsletter tool', 'Cloud infrastructure'.
    label: NonEmptyStringSchema,
    legalEntity: z
      .object({
        name: NonEmptyStringSchema,
        registry: z.string().optional(),
        registryId: z.string().optional(),
      })
      .optional(),
    // Where the contracting entity sits, and where its parent sits if that differs.
    jurisdiction: CountryCodeSchema,
    parentJurisdiction: CountryCodeSchema.optional(),
    role: VendorRoleSchema,
    // 0 is the customer, 1 a direct processor, 2 a sub-processor, and so on.
    level: z.number().int().min(0),
    parentVendorId: IdSchema.optional(),
    hosts: z.array(HostnameSchema).default([]),
    resolution: VendorResolutionSchema,
    provenance: VendorProvenanceSchema,
    transfer: z
      .object({
        outsideEea: z.boolean(),
        mechanism: TransferMechanismSchema.optional(),
      })
      .optional(),
  })
  .superRefine((v, ctx) => {
    if (v.resolution === 'resolved' && v.legalEntity === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['legalEntity'],
        message: 'a resolved vendor names its legal entity',
      });
    }
    // Level 1 hangs off the customer, who is not a vendor. Anything deeper names the
    // vendor it is a sub-processor of.
    if (v.level > 1 && v.parentVendorId === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['parentVendorId'],
        message: 'a sub-processor hangs off a parent vendor',
      });
    }
  })
  .describe('A recipient of personal data in the supply chain');
export type Vendor = z.infer<typeof VendorSchema>;
