import { z } from 'zod';
import { EvidenceRefSchema } from './evidence.js';
import {
  CountryCodeSchema,
  HostnameSchema,
  IsoDateTimeSchema,
  NonEmptyStringSchema,
} from './primitives.js';
import { VendorRoleSchema } from './vendor.js';

// DNS collection (D-01): what a domain's public records say about who handles its mail
// and who has been allowed to verify ownership of it. Verification tokens and SPF
// includes are mapped to named services through a curated, versioned, provenance-
// tracked map; a token the map does not know is reported as unknown with its raw
// value, never guessed at.

// A DNS name, which unlike a hostname may carry underscores: _spf.google.com, _dmarc.x.
export const DnsNameSchema = z
  .string()
  .regex(/^(?=.{1,253}$)([a-z0-9_-]+\.)+[a-z0-9_-]+$/i, 'dns name')
  .describe('DNS name, underscores allowed');

export const DNS_RECORD_TYPES = ['TXT', 'MX', 'CNAME'] as const;
export const DnsRecordTypeSchema = z.enum(DNS_RECORD_TYPES);

export const DnsRecordSchema = z.object({
  name: DnsNameSchema,
  type: DnsRecordTypeSchema,
  value: z.string(),
  priority: z.number().int().min(0).optional(),
});
export type DnsRecord = z.infer<typeof DnsRecordSchema>;

export const SpfSchema = z.object({
  raw: z.string(),
  includes: z.array(DnsNameSchema),
  // ip4, ip6, a, mx and the like, as written.
  mechanisms: z.array(z.string()),
  all: z.enum(['-all', '~all', '?all', '+all']).optional(),
});
export type Spf = z.infer<typeof SpfSchema>;

export const DNS_MATCHES = ['txt_prefix', 'spf_include', 'mx_suffix', 'cname_suffix'] as const;
export const DnsMatchSchema = z.enum(DNS_MATCHES);
export type DnsMatch = z.infer<typeof DnsMatchSchema>;

// One entry of the token-to-service map. Data, reviewable without reading code.
export const DnsServiceSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
    name: NonEmptyStringSchema,
    // Where the contracting entity sits, as far as the map knows.
    jurisdiction: CountryCodeSchema,
    role: VendorRoleSchema,
    txtPrefixes: z.array(NonEmptyStringSchema).default([]),
    spfIncludes: z.array(DnsNameSchema).default([]),
    mxSuffixes: z.array(DnsNameSchema).default([]),
    cnameSuffixes: z.array(DnsNameSchema).default([]),
    provenance: z.object({
      // Where the pattern was read: the vendor's own documentation.
      url: z.url(),
      verifiedAt: IsoDateTimeSchema,
    }),
  })
  .refine(
    (s) =>
      s.txtPrefixes.length + s.spfIncludes.length + s.mxSuffixes.length + s.cnameSuffixes.length >
      0,
    { message: 'a service entry matches on something' },
  );
export type DnsService = z.infer<typeof DnsServiceSchema>;

export const DnsServiceMapSchema = z
  .object({
    version: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    services: z.array(DnsServiceSchema).min(1),
  })
  .superRefine((m, ctx) => {
    const ids = new Set<string>();
    m.services.forEach((s, i) => {
      if (ids.has(s.id)) {
        ctx.addIssue({ code: 'custom', path: ['services', i, 'id'], message: `duplicate ${s.id}` });
      }
      ids.add(s.id);
    });
  });
export type DnsServiceMap = z.infer<typeof DnsServiceMapSchema>;

export const MappedServiceSchema = z.object({
  serviceId: z.string(),
  name: NonEmptyStringSchema,
  jurisdiction: CountryCodeSchema,
  role: VendorRoleSchema,
  matchedBy: DnsMatchSchema,
  record: DnsRecordSchema,
  // The part of the record that matched: the token, the include, the exchange.
  raw: z.string(),
});
export type MappedService = z.infer<typeof MappedServiceSchema>;

export const UnknownTokenSchema = z.object({
  kind: z.enum(['verification_token', 'spf_include', 'mx_exchange', 'cname_target']),
  raw: z.string(),
  record: DnsRecordSchema,
});
export type UnknownToken = z.infer<typeof UnknownTokenSchema>;

export const DnsCollectionSchema = z
  .object({
    domain: HostnameSchema,
    collectedAt: IsoDateTimeSchema,
    mapVersion: z.string(),
    records: z.array(DnsRecordSchema),
    spf: SpfSchema.optional(),
    dmarc: z.string().optional(),
    services: z.array(MappedServiceSchema),
    unknown: z.array(UnknownTokenSchema),
    evidence: z.array(EvidenceRefSchema),
  })
  .describe('What a domain’s public DNS says about its mail and its verified services');
export type DnsCollection = z.infer<typeof DnsCollectionSchema>;
