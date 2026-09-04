import {
  AGREEMENT_FINDINGS,
  AgreementAnalysisSchema,
  parseProvisionRef,
  type AgreementAnalysis,
  type AgreementClause,
  type AgreementElement,
  type Claim,
  type EvidenceRef,
  type Jurisdiction,
  type Locale,
  type SpecificCheck,
  type UntrustedContent,
} from '@gc/contracts';
import type { ModelClient } from './model-client.js';
import { claimOf } from './workers/shared.js';

// Processing agreement analysis (D-06): one agreement, element by element, against what
// a contract with a processor must stipulate. The model reads the document fenced as
// data and says, per element, present with a verbatim quote, absent, or undetermined;
// the client's guard has checked every quote against the document. Three elements are
// then read again in code for what the clause commits to: how fast a breach is
// notified, whether a new sub-processor can be objected to, and what a transfer outside
// the EEA rests on. A missing element or a failed check makes the agreement inadequate,
// which is a finding; an unclear clause leaves the verdict open, never adequate.
//
// Every claim this produces points at the stored document, quotes it where it can, and
// carries the provision from the table where it is a legal claim, so the verifier gate
// (A-07) can check all of it by comparison. Nothing here trusts the model with a fact.

export const AGREEMENT_READER = 'agreement_reader';

export interface AgreementAnalysisInput {
  readonly document: UntrustedContent;
  // The stored evidence the document was read from; findings and claims point at it.
  readonly documentEvidence: EvidenceRef;
  readonly elements: readonly AgreementElement[];
  readonly jurisdiction: Jurisdiction;
  readonly locale: Locale;
}

export const AGREEMENT_SYSTEM_PROMPT = [
  'You read one data processing agreement between a company and a supplier that',
  'processes personal data for it, and check it, element by element, against a list of',
  'things such an agreement must stipulate. For each element answer "present" only if',
  'the agreement actually stipulates it, and quote the sentence or clause verbatim from',
  'the document; answer "absent" if the document says nothing about it; answer',
  '"undetermined" if the document touches on it but does not clearly commit to it, or',
  'if you are not sure. Never guess: an unclear clause is undetermined, not present.',
  'Where an element asks how fast, how much notice, or what a transfer rests on, quote',
  'the sentence that states the time, the notice and the way to object, or the',
  'safeguard. Do not paraphrase in the quote. Never say whether the agreement is lawful,',
  'compliant or approved. Answer as JSON.',
].join(' ');

export function agreementPrompt(input: AgreementAnalysisInput): { system: string; user: string } {
  const lines: string[] = [];
  lines.push(
    `The agreement is held by a company in ${input.jurisdiction}, which is the controller. Check these elements:`,
  );
  for (const e of input.elements) lines.push(`- ${e.id}: ${e.asks}`);
  lines.push('');
  lines.push(
    'Answer with one entry per element id, in the order given. The document follows, fenced as untrusted content.',
  );
  return { system: AGREEMENT_SYSTEM_PROMPT, user: lines.join('\n') };
}

// ---- the specific checks, in code ------------------------------------------------------

const WORD_NUMBERS: Readonly<Record<string, number>> = {
  'twenty-four': 24,
  'twenty four': 24,
  'forty-eight': 48,
  'forty eight': 48,
  'seventy-two': 72,
  'seventy two': 72,
  fireogtyve: 24,
  otteogfyrre: 48,
  tooghalvfjerds: 72,
  vierundzwanzig: 24,
  achtundvierzig: 48,
  zweiundsiebzig: 72,
};
const NUMBER = `(\\d{1,3}|${Object.keys(WORD_NUMBERS).join('|')})`;
const HOURS = new RegExp(
  `\\b${NUMBER}\\s*(?:\\(\\d+\\)\\s*)?(?:hours?|hrs?|timer|stunden)\\b`,
  'i',
);
const DAYS = new RegExp(
  `\\b${NUMBER}\\s*(?:\\(\\d+\\)\\s*)?(business|working|calendar|arbejds|hverdags|kalender|werk|arbeits)?[- ]?(?:days?|dage|tage?n?)\\b`,
  'i',
);
const UNDUE_DELAY =
  /without (undue|unreasonable) delay|without delay|immediately|promptly|as soon as|uden ugrundet ophold|uden unødig(t)? (forsinkelse|ophold)|uden ugrundet forsinkelse|straks|omgående|snarest|hurtigst muligt|unverzüglich|ohne (unangemessene|schuldhafte) Verzögerung|ohne schuldhaftes Zögern|umgehend|sofort/i;

const NOTICE =
  /\b(inform|notif|announce|advise|notice|underret|orienter|varsl|meddel|informier|mitteil|benachrichtig|ankündig|unterricht|vorab)/i;
const OBJECTION =
  /\b(object|opposi|indsigelse|modsætte|protest|widerspr|widerspruch|einspruch|einwand)/i;

const SAFEGUARD =
  /standard contractual clauses|standard data protection clauses|\bSCCs?\b|standardkontraktbestemmelser|standardkontraktklausuler|standardkontrakt|Standardvertragsklauseln|Standarddatenschutzklauseln|adequacy decision|adequate level of protection|tilstrækkelighedsafgørelse|tilstrækkeligt beskyttelsesniveau|Angemessenheitsbeschluss|angemessenes Schutzniveau|binding corporate rules|bindende virksomhedsregler|verbindliche interne Datenschutzvorschriften|Data Privacy Framework/i;
const NO_TRANSFER =
  /\b(no transfer|not (be )?transferred|are not transferred|is not transferred|only within the (EU|EEA|European)|within the EEA|within the European Economic Area|within the EU|inden for (EU|EØS)|ikke overføre|overføres ikke|innerhalb (der EU|des EWR|der Europäischen Union|des Europäischen Wirtschaftsraums)|nicht (in Drittländer |in ein Drittland )?übermittelt|keine Übermittlung|keine Drittlandübermittlung)/i;

const numberOf = (raw: string): number => {
  const n = Number(raw);
  return Number.isFinite(n) ? n : (WORD_NUMBERS[raw.toLowerCase()] ?? NaN);
};

// The time a clause commits to, in hours, or undefined when it names none. A count of
// days is taken as calendar days; a business-day count is longer still and reads as
// such in the detail.
export function breachWindowHours(quote: string): { hours: number; business: boolean } | undefined {
  const h = HOURS.exec(quote);
  if (h && h[1] !== undefined) return { hours: numberOf(h[1]), business: false };
  const d = DAYS.exec(quote);
  if (d && d[1] !== undefined) {
    const business = /business|working|arbejds|hverdags|werk|arbeits/i.test(d[2] ?? '');
    return { hours: numberOf(d[1]) * 24, business };
  }
  return undefined;
}

export function checkBreachWindow(
  clause: AgreementClause,
  element: AgreementElement,
): SpecificCheck {
  const base = { specific: 'breach_window' as const, element: clause.element };
  if (clause.status === 'absent')
    return {
      ...base,
      status: 'not_met',
      detail: 'the agreement has no clause on notifying a personal data breach',
    };
  if (clause.status !== 'present' || clause.quote === undefined)
    return {
      ...base,
      status: 'undetermined',
      detail: 'the clause on breaches could not be read clearly',
    };
  const limit = element.limitHours;
  const window = breachWindowHours(clause.quote);
  if (window) {
    const stated = window.business
      ? `${window.hours / 24} business day(s), ${window.hours} hours at the least`
      : `${window.hours} hours`;
    if (limit !== undefined && window.hours > limit)
      return {
        ...base,
        status: 'not_met',
        detail: `the clause commits to notice within ${stated}; the company itself has ${limit} hours from becoming aware, so this leaves it none`,
        quote: clause.quote,
        hours: window.hours,
      };
    return {
      ...base,
      status: 'met',
      detail: `the clause commits to notice within ${stated}`,
      quote: clause.quote,
      hours: window.hours,
    };
  }
  if (UNDUE_DELAY.test(clause.quote))
    return {
      ...base,
      status: 'met',
      detail: 'the clause commits to notice without undue delay and names no fixed time',
      quote: clause.quote,
    };
  return {
    ...base,
    status: 'not_met',
    detail: 'the clause promises notice of a breach but names no time',
    quote: clause.quote,
  };
}

export function checkSubprocessorObjection(clause: AgreementClause): SpecificCheck {
  const base = { specific: 'subprocessor_objection' as const, element: clause.element };
  if (clause.status === 'absent')
    return {
      ...base,
      status: 'not_met',
      detail: 'the agreement gives no notice of new sub-processors and no way to object',
    };
  if (clause.status !== 'present' || clause.quote === undefined)
    return {
      ...base,
      status: 'undetermined',
      detail: 'the clause on sub-processors could not be read clearly',
    };
  const notice = NOTICE.test(clause.quote);
  const objection = OBJECTION.test(clause.quote);
  if (notice && objection)
    return {
      ...base,
      status: 'met',
      detail: 'the clause gives notice of a new sub-processor and a way to object',
      quote: clause.quote,
    };
  if (notice)
    return {
      ...base,
      status: 'not_met',
      detail: 'the clause announces new sub-processors but gives no way to object',
      quote: clause.quote,
    };
  return {
    ...base,
    status: 'not_met',
    detail: 'the clause allows new sub-processors without notice in advance',
    quote: clause.quote,
  };
}

export function checkTransferAnnex(clause: AgreementClause): SpecificCheck {
  const base = { specific: 'transfer_annex' as const, element: clause.element };
  if (clause.status === 'absent')
    return {
      ...base,
      status: 'not_met',
      detail: 'the agreement says nothing about transfers outside the EEA',
    };
  if (clause.status !== 'present' || clause.quote === undefined)
    return {
      ...base,
      status: 'undetermined',
      detail: 'the clause on transfers could not be read clearly',
    };
  if (NO_TRANSFER.test(clause.quote))
    return {
      ...base,
      status: 'met',
      detail: 'the clause rules out transfers outside the EEA',
      quote: clause.quote,
    };
  if (SAFEGUARD.test(clause.quote))
    return {
      ...base,
      status: 'met',
      detail: 'the clause names the safeguard a transfer rests on',
      quote: clause.quote,
    };
  return {
    ...base,
    status: 'not_met',
    detail: 'the clause mentions transfers but annexes no safeguard and rules none out',
    quote: clause.quote,
  };
}

export function specificCheck(
  clause: AgreementClause,
  element: AgreementElement,
): SpecificCheck | undefined {
  switch (element.specific) {
    case 'breach_window':
      return checkBreachWindow(clause, element);
    case 'subprocessor_objection':
      return checkSubprocessorObjection(clause);
    case 'transfer_annex':
      return checkTransferAnnex(clause);
    default:
      return undefined;
  }
}

// The exact span of the document a quote came from. The guard compares with runs of
// whitespace collapsed; the verifier compares character for character, so the quote
// that goes on record is the document's own text.
export function exactSpan(text: string, quote: string): string | undefined {
  if (text.includes(quote)) return quote;
  const pattern = quote
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s+');
  const m = new RegExp(pattern).exec(text);
  return m ? m[0] : undefined;
}

export async function analyseAgreement(
  client: Pick<ModelClient, 'call'>,
  input: AgreementAnalysisInput,
): Promise<AgreementAnalysis> {
  const output = await client.call({
    name: 'analyse_agreement_clauses',
    input: {
      document: input.document,
      elements: input.elements.map((e) => e.id),
      jurisdiction: input.jurisdiction,
      locale: input.locale,
    },
    ...agreementPrompt(input),
  });
  const answered = new Map(output.clauses.map((c) => [c.element, c]));
  const clauses: AgreementClause[] = input.elements.map((e) => {
    const a = answered.get(e.id);
    const citation = parseProvisionRef(e.citation.instrument, e.citation.ref, {
      ...(e.citation.note !== undefined ? { note: e.citation.note } : {}),
    });
    if (!citation)
      throw new Error(
        `agreement element ${e.id} cites "${e.citation.instrument} ${e.citation.ref}", which does not parse`,
      );
    const quote =
      a?.status === 'present' && a.quote !== undefined
        ? exactSpan(input.document.text, a.quote)
        : undefined;
    // A present answer whose quote cannot be placed in the document is not present.
    const status =
      a?.status === 'present' && quote === undefined
        ? 'undetermined'
        : (a?.status ?? 'undetermined');
    return {
      element: e.id,
      status,
      ...(status === 'present' && quote !== undefined ? { quote } : {}),
      ...(a?.note !== undefined ? { note: a.note } : {}),
      citation,
      ...(e.specific !== undefined ? { specific: e.specific } : {}),
    };
  });
  const byId = new Map(input.elements.map((e) => [e.id, e]));
  const specifics = clauses
    .map((c) => specificCheck(c, byId.get(c.element)!))
    .filter((s): s is SpecificCheck => s !== undefined);
  const missing = clauses.filter((c) => c.status === 'absent').map((c) => c.element);
  const undetermined = clauses.filter((c) => c.status === 'undetermined').map((c) => c.element);
  const failed = specifics.filter((s) => s.status === 'not_met').map((s) => s.element);
  const open = undetermined.length > 0 || specifics.some((s) => s.status === 'undetermined');
  const verdict =
    missing.length > 0 || failed.length > 0 ? 'inadequate' : open ? 'undetermined' : 'adequate';
  const shortfall = [...new Set([...missing, ...failed])];
  return AgreementAnalysisSchema.parse({
    documentHash: input.document.hash,
    jurisdiction: input.jurisdiction,
    locale: input.locale,
    clauses,
    specifics,
    missing,
    undetermined,
    verdict,
    drafts:
      verdict === 'inadequate'
        ? [
            {
              typeId: AGREEMENT_FINDINGS.inadequate,
              elements: shortfall,
              evidence: [input.documentEvidence],
            },
          ]
        : [],
  });
}

// ---- claims, for the gate ---------------------------------------------------------------

export interface AgreementClaimContext {
  readonly caseId: string;
  readonly documentEvidence: EvidenceRef;
  readonly elements: readonly AgreementElement[];
  // A legal claim records the corpus version its citations resolved against.
  readonly corpusVersion: string;
  readonly taskId: string;
  readonly at: Date;
  readonly model?: string;
}

// What the reading asserts, as claims the verifier can check: an observation per element
// the agreement stipulates, quoting it; a legal claim per element it leaves out or per
// check it fails, citing the provision the element rests on. Undetermined elements
// assert nothing.
export function agreementClaims(analysis: AgreementAnalysis, ctx: AgreementClaimContext): Claim[] {
  const byId = new Map(ctx.elements.map((e) => [e.id, e]));
  const label = (id: string) => byId.get(id)?.label['en'] ?? id;
  const out: Claim[] = [];
  const base = {
    caseId: ctx.caseId,
    worker: AGREEMENT_READER,
    taskId: ctx.taskId,
    at: ctx.at,
    ...(ctx.model ? { model: ctx.model } : {}),
  };
  for (const c of analysis.clauses) {
    if (c.status === 'present' && c.quote !== undefined) {
      out.push(
        claimOf({
          ...base,
          kind: 'observation',
          statement: `The agreement stipulates ${label(c.element).toLowerCase()}: "${c.quote}"`,
          evidence: [{ ...ctx.documentEvidence, quote: c.quote }],
        }),
      );
    } else if (c.status === 'absent') {
      const e = byId.get(c.element);
      out.push(
        claimOf({
          ...base,
          kind: 'legal',
          statement: `The agreement does not stipulate ${e?.asks ?? c.element}; a contract governing processing by a processor must.`,
          evidence: [ctx.documentEvidence],
          citations: [c.citation],
          jurisdiction: analysis.jurisdiction,
          corpusVersion: ctx.corpusVersion,
        }),
      );
    }
  }
  for (const s of analysis.specifics) {
    if (s.status !== 'not_met') continue;
    const clause = analysis.clauses.find((c) => c.element === s.element);
    if (!clause || clause.status === 'absent') continue; // the absent element's claim already stands
    out.push(
      claimOf({
        ...base,
        kind: 'legal',
        statement: `${label(s.element)}: ${s.detail}.`,
        evidence: [s.quote ? { ...ctx.documentEvidence, quote: s.quote } : ctx.documentEvidence],
        citations: [clause.citation],
        jurisdiction: analysis.jurisdiction,
        corpusVersion: ctx.corpusVersion,
      }),
    );
  }
  return out;
}
