import { z } from 'zod';
import { EvidenceRefSchema } from './evidence.js';
import { SeveritySchema } from './finding.js';
import { FindingTypeIdSchema, IsoDateTimeSchema } from './primitives.js';
import { SensitivitySchema } from './forms.js';

// Session replay and fingerprinting (S-13). A replay or heatmap tool is recognised by
// the hosts it talks to and by the globals it leaves on the page; whether it masks
// what people type is reported only where that is observable. Fingerprinting is
// observed directly: the probes a script runs against the canvas, the installed fonts
// and the audio stack are counted as they happen, with the script that ran them.

export const REPLAY_CHECKS = {
  replay_on_sensitive: 'REC-01',
  canvas: 'FPR-01',
  font: 'FPR-02',
  audio: 'FPR-03',
} as const;
export type ReplayCheckId = keyof typeof REPLAY_CHECKS;
export const ReplayCheckIdSchema = z.enum(
  Object.keys(REPLAY_CHECKS) as [ReplayCheckId, ...ReplayCheckId[]],
);

// How a tool was recognised.
export const REPLAY_SIGNALS = ['network', 'api'] as const;
export const ReplaySignalSchema = z.enum(REPLAY_SIGNALS);

// What can be said about input masking from the page alone.
export const MASKING_STATES = ['on', 'off', 'unknown'] as const;
export const MaskingStateSchema = z.enum(MASKING_STATES);
export type MaskingState = z.infer<typeof MaskingStateSchema>;

export const ReplayToolSchema = z.object({
  // The catalogue id of the tool, e.g. 'hotjar'.
  id: z.string().min(1),
  name: z.string().min(1),
  signals: z.array(ReplaySignalSchema).min(1),
  hosts: z.array(z.string()),
  globals: z.array(z.string()),
  masking: MaskingStateSchema,
  // Why masking is what it is: the markers looked for and what carried them.
  maskingDetail: z.string(),
});
export type ReplayTool = z.infer<typeof ReplayToolSchema>;

export const FingerprintProbeSchema = z.object({
  kind: z.enum(['canvas', 'font', 'audio']),
  calls: z.number().int().min(0),
  // The scripts whose stack the calls came from, by URL.
  scripts: z.array(z.string()),
  // Kind-specific: fonts measured, canvas text drawn, audio nodes created.
  detail: z.record(z.string(), z.unknown()).default({}),
});
export type FingerprintProbe = z.infer<typeof FingerprintProbeSchema>;

export const ReplayObservationSchema = z
  .object({
    check: ReplayCheckIdSchema,
    findingTypeId: FindingTypeIdSchema,
    outcome: z.enum(['pass', 'fail']),
    severity: SeveritySchema,
    summary: z.string().min(1),
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
    if (o.findingTypeId !== REPLAY_CHECKS[o.check]) {
      ctx.addIssue({
        code: 'custom',
        path: ['findingTypeId'],
        message: `check ${o.check} maps to ${REPLAY_CHECKS[o.check]}`,
      });
    }
  })
  .describe('One replay or fingerprinting check, and what it saw');
export type ReplayObservation = z.infer<typeof ReplayObservationSchema>;

export const ReplayPageSchema = z.object({
  page: z.string().min(1),
  // What the page's forms ask for; replay on a page with payment or account fields is
  // the case that matters.
  sensitivity: SensitivitySchema,
  sensitiveFields: z.array(z.string()),
  tools: z.array(ReplayToolSchema),
  probes: z.array(FingerprintProbeSchema),
  evidence: EvidenceRefSchema,
});
export type ReplayPage = z.infer<typeof ReplayPageSchema>;

export const ReplayReportSchema = z
  .object({
    site: z.string().min(1),
    startedAt: IsoDateTimeSchema,
    pages: z.array(ReplayPageSchema).min(1),
    observations: z.array(ReplayObservationSchema),
  })
  .describe('Replay tools and fingerprinting probes seen on a site');
export type ReplayReport = z.infer<typeof ReplayReportSchema>;
