import { z } from 'zod';
import {
  CaseIdSchema,
  HostnameSchema,
  IdSchema,
  IsoDateTimeSchema,
  NonEmptyStringSchema,
  ScanPassSchema,
  Sha256Schema,
  TenantIdSchema,
  UrlSchema,
} from './primitives.js';

// Evidence is what deterministic code observed. Rows are immutable and content-addressed
// (F-03), so a reference carries the hash and any quote can be checked against the stored
// body by exact substring match (A-07). The model never produces evidence; it only points
// at it.

export const EVIDENCE_KINDS = [
  'http_request',
  'cookie',
  'storage',
  'dom_snapshot',
  'screenshot',
  'header',
  'form',
  'document',
  'pass_diff',
  'registry_record',
  'answer',
  'text',
] as const;
export const EvidenceKindSchema = z
  .enum(EVIDENCE_KINDS)
  .describe('What kind of observation this is');
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;

export const EvidenceSourceSchema = z
  .object({
    url: UrlSchema.optional(),
    host: HostnameSchema.optional(),
    path: z.string().optional(),
    pass: ScanPassSchema.optional(),
    registry: z.string().optional().describe('Registry name for registry_record'),
    questionId: IdSchema.optional().describe('Question id for answer evidence'),
  })
  .describe('Where the observation was made');
export type EvidenceSource = z.infer<typeof EvidenceSourceSchema>;

export const EvidenceSchema = z
  .object({
    id: IdSchema,
    tenantId: TenantIdSchema,
    caseId: CaseIdSchema,
    scanId: IdSchema.optional(),
    kind: EvidenceKindSchema,
    capturedAt: IsoDateTimeSchema,
    source: EvidenceSourceSchema,
    // Canonical serialisation of the observation. The hash is computed over exactly this.
    body: z.string(),
    hash: Sha256Schema,
    // A one-line human caption, e.g. "Pass B (reject all) vs Pass C (accept all)".
    caption: z.string().optional(),
  })
  .describe('An immutable, content-addressed observation');
export type Evidence = z.infer<typeof EvidenceSchema>;

// The pointer every claim, finding and explanation must carry.
export const EvidenceRefSchema = z
  .object({
    evidenceId: IdSchema,
    hash: Sha256Schema,
    // Optional verbatim excerpt. Must be an exact substring of the evidence body; the
    // verifier enforces that in code.
    quote: z.string().min(1).optional(),
  })
  .describe('Pointer to stored evidence, with an optional verbatim quote');
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

// Anything scraped from the outside world is attacker-controlled (A-10). It enters a
// prompt only wrapped in this shape, so the label cannot be forgotten and the text can
// be delimited by the prompt builder.
export const UntrustedContentSchema = z
  .object({
    trust: z.literal('untrusted'),
    source: z.object({
      url: UrlSchema.optional(),
      host: HostnameSchema.optional(),
      description: NonEmptyStringSchema.describe('e.g. "privacy policy page"'),
      fetchedAt: IsoDateTimeSchema,
    }),
    mediaType: z.string().default('text/plain'),
    hash: Sha256Schema,
    text: z.string(),
  })
  .describe('Scraped content: data, never instructions');
export type UntrustedContent = z.infer<typeof UntrustedContentSchema>;
