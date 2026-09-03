import { z } from 'zod';
import { EvidenceRefSchema } from './evidence.js';
import { FindingTypeIdSchema } from './primitives.js';

// The security surface a stranger can see (S-12): transport, headers, mixed content,
// form downgrades, referrer leakage, exposed paths. Each check is deterministic and
// yields an observation — pass, fail, or undetermined — with the evidence it rests on.
// Assembly (S-14) turns a failed observation into a finding; the finding type each
// check maps to is fixed here, and every one of them has a remedy in the catalogue.

export const SECURITY_CHECKS = {
  transport: 'SEC-01',
  form_downgrade: 'SEC-02',
  hsts: 'SEC-03',
  mixed_content: 'SEC-04',
  referrer_policy: 'SEC-05',
  security_headers: 'SEC-06',
  exposed_paths: 'SEC-07',
} as const;
export type SecurityCheckId = keyof typeof SECURITY_CHECKS;
export const SecurityCheckIdSchema = z.enum(
  Object.keys(SECURITY_CHECKS) as [SecurityCheckId, ...SecurityCheckId[]],
);

export const SecurityObservationSchema = z
  .object({
    check: SecurityCheckIdSchema,
    findingTypeId: FindingTypeIdSchema,
    outcome: z.enum(['pass', 'fail', 'undetermined']),
    // What was seen, in words a reader can check against the evidence.
    summary: z.string().min(1),
    // Structured detail per check: the paths, the headers, the hosts.
    detail: z.record(z.string(), z.unknown()).default({}),
    evidence: z.array(EvidenceRefSchema).default([]),
  })
  .superRefine((o, ctx) => {
    if (o.outcome === 'fail' && o.evidence.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['evidence'],
        message: 'a failed check points at evidence',
      });
    }
    if (o.findingTypeId !== SECURITY_CHECKS[o.check]) {
      ctx.addIssue({
        code: 'custom',
        path: ['findingTypeId'],
        message: `check ${o.check} maps to ${SECURITY_CHECKS[o.check]}`,
      });
    }
  })
  .describe('One security check, and what it saw');
export type SecurityObservation = z.infer<typeof SecurityObservationSchema>;
