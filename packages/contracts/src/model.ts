import { z } from 'zod';
import { CaseSchema } from './case.js';
import { CookieCategorySchema } from './cookie.js';
import { ClaimSchema } from './claim.js';
import { EvidenceRefSchema, EvidenceSchema, UntrustedContentSchema } from './evidence.js';
import { FindingSchema } from './finding.js';
import { TaskCostSchema, TaskProposalSchema, TaskTypeSchema } from './planner.js';
import {
  FindingTypeIdSchema,
  HostnameSchema,
  JurisdictionSchema,
  LocaleSchema,
  NonEmptyStringSchema,
} from './primitives.js';

// Every model call has its input and output schema here and nowhere else (F-04, T-04).
// Inputs are what the prompt builder receives, already typed, with scraped material
// wrapped as untrusted (A-10). Outputs are strict objects: an unknown key is a parse
// failure, and a parse failure has one defined behaviour — retry once, then fail loudly.
//
// The model never asserts a fact. Where an output makes a claim about the world it must
// point at evidence or quote a passage, and the verifier (A-07) checks the pointer.

const Prose = z.string().trim().min(1).max(4000);

export const GroundedRowSchema = z.strictObject({
  label: NonEmptyStringSchema,
  value: NonEmptyStringSchema,
});
export type GroundedRow = z.infer<typeof GroundedRowSchema>;

const PassageSchema = z.object({
  key: NonEmptyStringSchema.describe('Citation key, see citationKey()'),
  ref: NonEmptyStringSchema,
  text: z.string(),
});

// Clause analysis, one shape for a policy (S-10) and for a processing agreement (D-06):
// for each required element, present, absent or undetermined. "Present" must quote the
// clause verbatim so it can be checked by substring match.
const ClauseAnalysisCall = {
  input: z.object({
    document: UntrustedContentSchema,
    elements: z.array(NonEmptyStringSchema).min(1),
    jurisdiction: JurisdictionSchema,
    locale: LocaleSchema,
  }),
  output: z
    .strictObject({
      clauses: z
        .array(
          z.strictObject({
            element: NonEmptyStringSchema,
            status: z.enum(['present', 'absent', 'undetermined']),
            quote: z.string().optional(),
            note: z.string().optional(),
          }),
        )
        .min(1),
    })
    .superRefine((o, ctx) => {
      o.clauses.forEach((c, i) => {
        if (c.status === 'present' && (c.quote === undefined || c.quote.trim() === '')) {
          ctx.addIssue({
            code: 'custom',
            path: ['clauses', i, 'quote'],
            message: 'a clause reported present must be quoted verbatim',
          });
        }
      });
    }),
};

export const MODEL_CALLS = {
  // Turn a finding and its evidence into the plain-language "why".
  explain_finding: {
    input: z.object({
      finding: FindingSchema,
      evidence: z.array(EvidenceSchema).min(1),
      locale: LocaleSchema,
      untrusted: z.array(UntrustedContentSchema).default([]),
    }),
    output: z.strictObject({
      why: Prose,
      grounded: z.array(GroundedRowSchema).min(1),
      evidence: z.array(EvidenceRefSchema).min(1),
    }),
  },

  // Order the open findings into steps a person can take, one at a time.
  prioritise_plan: {
    input: z.object({
      findings: z.array(FindingSchema).min(1),
      locale: LocaleSchema,
    }),
    output: z.strictObject({
      steps: z
        .array(
          z.strictObject({
            n: z.number().int().min(1),
            title: Prose,
            plain: Prose,
            minutes: z.number().int().min(1),
            who: Prose,
            findingTypeIds: z.array(FindingTypeIdSchema).min(1),
          }),
        )
        .min(1),
    }),
  },

  // Draft a message a customer can send in one click.
  draft_message: {
    input: z.object({
      finding: FindingSchema,
      evidence: z.array(EvidenceSchema).min(1),
      recipientRole: NonEmptyStringSchema,
      locale: LocaleSchema,
      untrusted: z.array(UntrustedContentSchema).default([]),
    }),
    output: z.strictObject({
      to: Prose,
      subject: Prose,
      body: Prose,
    }),
  },

  // Draft a prompt for the customer's coding assistant. It must name the real domain,
  // hosts and paths; the caller checks that against the input.
  draft_agent_prompt: {
    input: z.object({
      finding: FindingSchema,
      evidence: z.array(EvidenceSchema).min(1),
      domain: HostnameSchema,
      locale: LocaleSchema,
    }),
    output: z.strictObject({
      body: Prose,
    }),
  },

  // The case-grounded advisor (V-02): the answer, what the case says and what the law
  // says, kept apart. caseSays may name only rows the case supplied; lawSays may quote
  // only passages offered, verbatim; a refusal says what the case would need.
  advise: {
    input: z.object({
      question: NonEmptyStringSchema,
      locale: LocaleSchema,
      jurisdiction: JurisdictionSchema,
      facts: z.array(GroundedRowSchema).default([]),
      passages: z.array(PassageSchema).default([]),
    }),
    output: z.strictObject({
      answer: Prose,
      caseSays: z.array(GroundedRowSchema).max(12),
      lawSays: z
        .array(z.strictObject({ key: NonEmptyStringSchema, quote: NonEmptyStringSchema }))
        .max(6),
      refuse: z.boolean(),
      missing: Prose.optional(),
    }),
  },

  // Read a policy (S-10) against the disclosure table.
  analyse_policy_clauses: ClauseAnalysisCall,

  // Read a processing agreement (D-06) against the Article 28 table.
  analyse_agreement_clauses: ClauseAnalysisCall,

  // The verifier's second pass (A-07): does the evidence actually support the claim?
  review_claim: {
    input: z.object({
      claim: ClaimSchema,
      evidence: z.array(EvidenceSchema).min(1),
      passages: z.array(PassageSchema).default([]),
    }),
    output: z.strictObject({
      supported: z.boolean(),
      reason: Prose,
    }),
  },

  // The planner (A-06): propose tasks from the closed catalogue.
  plan_tasks: {
    input: z.object({
      case: CaseSchema,
      openFindingTypeIds: z.array(FindingTypeIdSchema),
      // The duties the rules derived (A-02), for the planner to work from.
      duties: z
        .array(
          z.object({
            ruleId: NonEmptyStringSchema,
            title: z.string(),
            status: z.enum(['applies', 'not_applicable', 'undetermined']),
            findingTypeIds: z.array(FindingTypeIdSchema).default([]),
          }),
        )
        .default([]),
      budget: TaskCostSchema,
      availableTypes: z.array(TaskTypeSchema).min(1),
      // What the case holds, as counts and ids; never scraped text.
      state: z
        .object({
          scanned: z.boolean().optional(),
          registerRows: z.number().int().min(0).optional(),
          registerConfirmed: z.number().int().min(0).optional(),
          unresolvedVendors: z.number().int().min(0).optional(),
          documentEvidenceIds: z.array(z.string()).optional(),
          unverifiedClaimIds: z.array(z.string()).optional(),
          policyPublished: z.boolean().optional(),
        })
        .optional(),
    }),
    output: z.strictObject({
      tasks: z.array(TaskProposalSchema),
    }),
  },

  // The assistant, from any element on a page: answer from the case and the corpus.
  answer_question: {
    input: z.object({
      question: NonEmptyStringSchema,
      locale: LocaleSchema,
      grounding: z.array(GroundedRowSchema).default([]),
      passages: z.array(PassageSchema).default([]),
      untrusted: z.array(UntrustedContentSchema).default([]),
    }),
    output: z.strictObject({
      answer: Prose,
      grounded: z.array(GroundedRowSchema),
      law: z
        .strictObject({
          key: NonEmptyStringSchema,
          quote: NonEmptyStringSchema.describe('Verbatim from the passage'),
        })
        .optional(),
      followups: z.array(Prose).max(3),
    }),
  },

  // A suggestion for cookies the database does not know (S-06). The classification is
  // always the database's; a suggestion is recorded as a suggestion, never as a category.
  classify_cookies: {
    input: z.object({
      cookies: z
        .array(
          z.object({
            name: NonEmptyStringSchema,
            host: HostnameSchema,
            path: z.string().optional(),
            expires: z.string().optional(),
            httpOnly: z.boolean().optional(),
          }),
        )
        .min(1),
    }),
    output: z.strictObject({
      cookies: z
        .array(
          z.strictObject({
            name: NonEmptyStringSchema,
            host: HostnameSchema,
            category: CookieCategorySchema,
            confidence: z.number().min(0).max(1),
          }),
        )
        .min(1),
    }),
  },
} as const satisfies Record<string, { input: z.ZodType; output: z.ZodType }>;

export type ModelCallName = keyof typeof MODEL_CALLS;
export const MODEL_CALL_NAMES = Object.keys(MODEL_CALLS) as ModelCallName[];

export type ModelInput<N extends ModelCallName> = z.input<(typeof MODEL_CALLS)[N]['input']>;
export type ModelOutput<N extends ModelCallName> = z.infer<(typeof MODEL_CALLS)[N]['output']>;

export type ModelParse<N extends ModelCallName> =
  { ok: true; value: ModelOutput<N> } | { ok: false; issues: string[] };

// The one way to turn raw model text into a typed value. Never JSON.parse at a call site.
export function parseModelOutput<N extends ModelCallName>(name: N, raw: unknown): ModelParse<N> {
  let candidate: unknown = raw;
  if (typeof raw === 'string') {
    try {
      candidate = JSON.parse(raw);
    } catch {
      return { ok: false, issues: ['output is not JSON'] };
    }
  }
  const result = MODEL_CALLS[name].output.safeParse(candidate);
  if (result.success) return { ok: true, value: result.data as ModelOutput<N> };
  return {
    ok: false,
    issues: result.error.issues.map(
      (i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`,
    ),
  };
}

// --- Transport envelopes -------------------------------------------------------------
// The OpenAI-compatible wire shapes the model client (T-04) accepts. Validated like any
// other model output: an envelope that does not match is a failed attempt, not a crash.

export const ChatCompletionResponseSchema = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        message: z.object({
          role: z.string().optional(),
          content: z.string().nullable(),
        }),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().optional(),
      completion_tokens: z.number().int().optional(),
      total_tokens: z.number().int().optional(),
    })
    .optional(),
});
export type ChatCompletionResponse = z.infer<typeof ChatCompletionResponseSchema>;

export const EmbeddingInputSchema = z.array(z.string().min(1)).min(1).max(256);
export type EmbeddingInput = z.infer<typeof EmbeddingInputSchema>;

export const EmbeddingResponseSchema = z.object({
  data: z
    .array(
      z.object({
        index: z.number().int().min(0),
        embedding: z.array(z.number()).min(1),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().optional(),
      total_tokens: z.number().int().optional(),
    })
    .optional(),
});
export type EmbeddingResponse = z.infer<typeof EmbeddingResponseSchema>;
