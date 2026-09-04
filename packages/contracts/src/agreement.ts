import { z } from 'zod';
import { CitationSchema } from './citation.js';
import { EvidenceRefSchema } from './evidence.js';
import { ClauseStatusSchema } from './policy.js';
import {
  FindingTypeIdSchema,
  HostnameSchema,
  IsoDateTimeSchema,
  JurisdictionSchema,
  LocaleSchema,
  LocalisedTextSchema,
  NonEmptyStringSchema,
  Sha256Schema,
  UrlSchema,
} from './primitives.js';

// Processing agreements (D-06): the contract Article 28(3) requires between a company and
// everyone who processes personal data on its behalf. Three things can be wrong, and they
// are three findings with three remedies: there is no agreement at all, an agreement is
// promised but cannot be found or read, or the agreement that was read leaves out what
// the contract must stipulate. What the contract must stipulate is a table of elements
// as content (packages/findings/content/agreement-elements.json), each resting on the
// provision it comes from, so the reader asks about elements and never about articles.

export const AGREEMENT_OUTCOMES = ['found', 'unfindable', 'none', 'unreachable'] as const;
export const AgreementOutcomeSchema = z.enum(AGREEMENT_OUTCOMES);
export type AgreementOutcome = z.infer<typeof AgreementOutcomeSchema>;

// The finding each outcome raises. Found is not a finding until the agreement is read;
// unreachable raises nothing, because a vendor site that did not answer proves nothing.
export const AGREEMENT_FINDINGS = {
  none: 'DPA-01',
  unfindable: 'DPA-02',
  inadequate: 'DPA-03',
} as const;

// Checks that go beyond presence: the clause is read in code for what it commits to.
export const AGREEMENT_SPECIFICS = [
  'breach_window',
  'subprocessor_objection',
  'transfer_annex',
] as const;
export const AgreementSpecificSchema = z.enum(AGREEMENT_SPECIFICS);
export type AgreementSpecific = z.infer<typeof AgreementSpecificSchema>;

export const AgreementElementSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]*$/),
  label: LocalisedTextSchema,
  // What the model is asked to look for, in one line.
  asks: NonEmptyStringSchema,
  citation: z.object({
    instrument: NonEmptyStringSchema,
    ref: NonEmptyStringSchema,
    note: z.string().optional(),
  }),
  specific: AgreementSpecificSchema.optional(),
  // For a check that reads a time: the most hours a clause may commit to. Content, not
  // code: the number comes from the provision the element cites.
  limitHours: z.number().int().positive().optional(),
});
export type AgreementElement = z.infer<typeof AgreementElementSchema>;

export const AgreementTableSchema = z
  .object({ version: z.number().int().min(1), elements: z.array(AgreementElementSchema).min(1) })
  .superRefine((t, ctx) => {
    const seen = new Set<string>();
    t.elements.forEach((e, i) => {
      if (seen.has(e.id))
        ctx.addIssue({ code: 'custom', path: ['elements', i], message: `${e.id} twice` });
      seen.add(e.id);
    });
    for (const s of AGREEMENT_SPECIFICS) {
      const carriers = t.elements.filter((e) => e.specific === s);
      if (carriers.length !== 1)
        ctx.addIssue({
          code: 'custom',
          path: ['elements'],
          message: `exactly one element carries the ${s} check, not ${carriers.length}`,
        });
    }
  });
export type AgreementTable = z.infer<typeof AgreementTableSchema>;

// What discovery found on a vendor's site: the agreement as a document, a promise of one
// that led nowhere (the trail says where), or nothing that mentions one.
export const AgreementTrailSchema = z.object({
  url: UrlSchema,
  status: z.number().int().optional(),
  reason: NonEmptyStringSchema,
});
export type AgreementTrail = z.infer<typeof AgreementTrailSchema>;

export const AgreementDocumentSchema = z.object({
  url: UrlSchema,
  finalUrl: UrlSchema,
  title: z.string().optional(),
  language: z.string().optional(),
  words: z.number().int().min(0),
  foundBy: z.enum(['link', 'well-known']),
  evidence: EvidenceRefSchema,
});
export type AgreementDocument = z.infer<typeof AgreementDocumentSchema>;

export const AgreementDiscoverySchema = z
  .object({
    vendor: z.object({ host: HostnameSchema, name: z.string().optional() }),
    startedAt: IsoDateTimeSchema,
    fetched: z.number().int().min(0),
    outcome: AgreementOutcomeSchema,
    document: AgreementDocumentSchema.optional(),
    trail: z.array(AgreementTrailSchema),
    summary: NonEmptyStringSchema,
    // What the outcome rests on: the document, or the pages searched.
    evidence: z.array(EvidenceRefSchema),
  })
  .superRefine((d, ctx) => {
    if ((d.outcome === 'found') !== (d.document !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['document'],
        message: 'found means a document, and a document means found',
      });
    }
    if (d.outcome !== 'unreachable' && d.evidence.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['evidence'],
        message: 'an outcome the scan reached rests on evidence',
      });
    }
  })
  .describe("What was found of a vendor's processing agreement");
export type AgreementDiscovery = z.infer<typeof AgreementDiscoverySchema>;

// One element of the table, read.
export const AgreementClauseSchema = z
  .object({
    element: NonEmptyStringSchema,
    status: ClauseStatusSchema,
    quote: z.string().min(1).optional(),
    note: z.string().optional(),
    citation: CitationSchema,
    specific: AgreementSpecificSchema.optional(),
  })
  .superRefine((c, ctx) => {
    if (c.status === 'present' && c.quote === undefined)
      ctx.addIssue({ code: 'custom', path: ['quote'], message: 'a present clause is quoted' });
    if (c.status !== 'present' && c.quote !== undefined)
      ctx.addIssue({
        code: 'custom',
        path: ['quote'],
        message: 'only a present clause carries a quote',
      });
  });
export type AgreementClause = z.infer<typeof AgreementClauseSchema>;

export const SPECIFIC_STATUSES = ['met', 'not_met', 'undetermined'] as const;
export const SpecificStatusSchema = z.enum(SPECIFIC_STATUSES);
export type SpecificStatus = z.infer<typeof SpecificStatusSchema>;

// A specific check, decided in code from the quoted clause: what it commits to, in the
// reader's words, with the number it read where there is one.
export const SpecificCheckSchema = z.object({
  specific: AgreementSpecificSchema,
  element: NonEmptyStringSchema,
  status: SpecificStatusSchema,
  detail: NonEmptyStringSchema,
  quote: z.string().min(1).optional(),
  hours: z.number().int().min(0).optional(),
});
export type SpecificCheck = z.infer<typeof SpecificCheckSchema>;

export const AGREEMENT_VERDICTS = ['adequate', 'inadequate', 'undetermined'] as const;
export const AgreementVerdictSchema = z.enum(AGREEMENT_VERDICTS);
export type AgreementVerdict = z.infer<typeof AgreementVerdictSchema>;

export const AgreementAnalysisSchema = z
  .object({
    documentHash: Sha256Schema,
    jurisdiction: JurisdictionSchema,
    locale: LocaleSchema,
    clauses: z.array(AgreementClauseSchema).min(1),
    specifics: z.array(SpecificCheckSchema),
    // Elements the agreement says nothing about, and elements the reader could not decide.
    missing: z.array(NonEmptyStringSchema),
    undetermined: z.array(NonEmptyStringSchema),
    // Inadequate on any missing element or any specific check not met; adequate only when
    // every element is present and every check met; undetermined in between. Never a
    // verdict about the company: a reading of one document against one table.
    verdict: AgreementVerdictSchema,
    drafts: z.array(
      z.object({
        typeId: FindingTypeIdSchema,
        elements: z.array(NonEmptyStringSchema).min(1),
        evidence: z.array(EvidenceRefSchema).min(1),
      }),
    ),
  })
  .superRefine((a, ctx) => {
    const absent = a.clauses.filter((c) => c.status === 'absent').map((c) => c.element);
    if (absent.join(',') !== a.missing.join(','))
      ctx.addIssue({
        code: 'custom',
        path: ['missing'],
        message: 'missing lists the absent elements',
      });
    const failed = a.specifics.some((s) => s.status === 'not_met');
    const open = a.undetermined.length > 0 || a.specifics.some((s) => s.status === 'undetermined');
    const expected =
      absent.length > 0 || failed ? 'inadequate' : open ? 'undetermined' : 'adequate';
    if (a.verdict !== expected)
      ctx.addIssue({
        code: 'custom',
        path: ['verdict'],
        message: `the verdict follows from the clauses: ${expected}`,
      });
    if ((a.verdict === 'inadequate') !== a.drafts.length > 0)
      ctx.addIssue({
        code: 'custom',
        path: ['drafts'],
        message: 'an inadequate agreement is a finding, and only that',
      });
  })
  .describe('A processing agreement checked element by element against Article 28');
export type AgreementAnalysis = z.infer<typeof AgreementAnalysisSchema>;
