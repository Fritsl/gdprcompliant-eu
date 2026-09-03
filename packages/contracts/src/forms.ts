import { z } from 'zod';
import { EvidenceRefSchema } from './evidence.js';
import { SeveritySchema } from './finding.js';
import { FindingTypeIdSchema, IsoDateTimeSchema } from './primitives.js';

// The form inventory (S-11): every form on the pages looked at, what each one asks for,
// where it goes, the consent controls on it and the state they are in, and whether a
// notice sits at the point of collection. Read-only: nothing is ever submitted. Each
// check is deterministic and yields an observation with the evidence it rests on.

export const FORM_CHECKS = {
  preticked: 'FRM-01',
  bundled: 'FRM-02',
  no_notice: 'FRM-03',
} as const;
export type FormCheckId = keyof typeof FORM_CHECKS;
export const FormCheckIdSchema = z.enum(
  Object.keys(FORM_CHECKS) as [FormCheckId, ...FormCheckId[]],
);

// What a field asks for, read from its name, type, label, autocomplete and placeholder.
export const FIELD_CATEGORIES = [
  'health',
  'belief',
  'financial',
  'identity',
  'credentials',
  'contact',
  'free_text',
  'other',
] as const;
export const FieldCategorySchema = z.enum(FIELD_CATEGORIES);
export type FieldCategory = z.infer<typeof FieldCategorySchema>;

// The most sensitive thing a form collects, which is what sets its severity.
export const SENSITIVITIES = ['special', 'financial', 'identity', 'contact', 'none'] as const;
export const SensitivitySchema = z.enum(SENSITIVITIES);
export type Sensitivity = z.infer<typeof SensitivitySchema>;

export const FormFieldSchema = z.object({
  name: z.string(),
  type: z.string(),
  id: z.string().optional(),
  label: z.string().optional(),
  autocomplete: z.string().optional(),
  placeholder: z.string().optional(),
  required: z.boolean().default(false),
  category: FieldCategorySchema,
});
export type FormField = z.infer<typeof FormFieldSchema>;

export const CONSENT_PURPOSES = ['marketing', 'terms', 'privacy', 'other'] as const;
export const ConsentPurposeSchema = z.enum(CONSENT_PURPOSES);
export type ConsentPurpose = z.infer<typeof ConsentPurposeSchema>;

// A checkbox (or a hidden input standing in for one) and the state it was found in.
export const ConsentControlSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  kind: z.enum(['checkbox', 'hidden_input']),
  label: z.string(),
  // Ticked in the markup, ticked by the time scripts have run, or both.
  checkedInMarkup: z.boolean(),
  checkedAfterScripts: z.boolean(),
  // Not visible to a person: display none, visibility hidden, zero size, or off-screen.
  hidden: z.boolean(),
  required: z.boolean(),
  purposes: z.array(ConsentPurposeSchema),
});
export type ConsentControl = z.infer<typeof ConsentControlSchema>;

export const NoticeSchema = z.object({
  found: z.boolean(),
  via: z.enum(['link', 'text']).optional(),
  text: z.string().optional(),
});

export const FormRecordSchema = z.object({
  page: z.string().min(1),
  index: z.number().int().min(0),
  action: z.string(),
  method: z.enum(['get', 'post', 'dialog']),
  submitLabel: z.string().optional(),
  fields: z.array(FormFieldSchema),
  controls: z.array(ConsentControlSchema),
  sensitivity: SensitivitySchema,
  notice: NoticeSchema,
  evidence: EvidenceRefSchema,
});
export type FormRecord = z.infer<typeof FormRecordSchema>;

export const FormObservationSchema = z
  .object({
    check: FormCheckIdSchema,
    findingTypeId: FindingTypeIdSchema,
    outcome: z.enum(['pass', 'fail']),
    // Set by the sensitivity of what the form collects; assembly (S-14) reads it.
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
    if (o.findingTypeId !== FORM_CHECKS[o.check]) {
      ctx.addIssue({
        code: 'custom',
        path: ['findingTypeId'],
        message: `check ${o.check} maps to ${FORM_CHECKS[o.check]}`,
      });
    }
  })
  .describe('One form check, and what it saw');
export type FormObservation = z.infer<typeof FormObservationSchema>;

export const FormInventorySchema = z
  .object({
    site: z.string().min(1),
    startedAt: IsoDateTimeSchema,
    // The pages looked at, landing page first; same host only.
    pages: z.array(z.string().min(1)).min(1),
    forms: z.array(FormRecordSchema),
    observations: z.array(FormObservationSchema),
    // Nothing was submitted. A literal, so a record claiming otherwise cannot be built.
    submitted: z.literal(false),
  })
  .describe('Every form found on a site, and the checks run over them');
export type FormInventory = z.infer<typeof FormInventorySchema>;
