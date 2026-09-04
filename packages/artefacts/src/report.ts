import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  FINDING_AREAS,
  LocalisedTextSchema,
  SEVERITIES,
  type Citation,
  type FindingArea,
  type FindingStatus,
  type Locale,
  type Quotation,
  type Severity,
  type VerbatimFailure,
  verbatim,
} from '@gc/contracts';
import { localise } from '@gc/i18n';

// The status report (V-01): the case as it stands right now, as a document a person hands
// to someone who never ran the scan. A status matrix by area in which "not determined"
// is a state of its own and never dressed up as a pass; numbered action points in the
// plan's own order, each with an owner and an effort; and every provision the case rests
// on, quoted in full from the corpus with a reference that resolves. The model is a pure
// function of its input, so the same case at the same moment is the same document.

const LocalisedRecord = <K extends string>(keys: readonly K[]) =>
  z.object(
    Object.fromEntries(keys.map((k) => [k, LocalisedTextSchema])) as Record<
      K,
      typeof LocalisedTextSchema
    >,
  );

const ContentSchema = z.object({
  title: LocalisedTextSchema,
  generated: LocalisedTextSchema,
  standing: LocalisedTextSchema,
  live: LocalisedTextSchema,
  summary: LocalisedTextSchema,
  sections: LocalisedRecord([
    'standing',
    'actions',
    'nothingToDo',
    'law',
    'quoted',
    'noLaw',
    'decisions',
    'advice',
    'adviceLead',
    'adviceCase',
    'adviceLaw',
    'adviceRefused',
    'adviceSettle',
    'adviceNotice',
  ] as const),
  columns: LocalisedRecord(['area', 'status', 'latest', 'action', 'who', 'effort'] as const),
  states: LocalisedRecord(['done', 'open', 'undetermined'] as const),
  notes: LocalisedRecord(['open', 'fixed', 'nothingFound', 'notChecked'] as const),
  unknownEffort: LocalisedTextSchema,
  areas: LocalisedRecord(FINDING_AREAS),
  roles: LocalisedRecord(['marketing', 'it', 'hr', 'finance'] as const),
  source: LocalisedTextSchema,
  asOf: LocalisedTextSchema,
  disclaimer: LocalisedTextSchema,
  page: LocalisedTextSchema,
});

export const REPORT_CONTENT_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'content',
  'report.json',
);
export const REPORT_CONTENT = ContentSchema.parse(
  JSON.parse(readFileSync(REPORT_CONTENT_FILE, 'utf8')),
);

export type AreaState = 'done' | 'open' | 'undetermined';
export type ReportRole = 'marketing' | 'it' | 'hr' | 'finance';

export interface ReportFindingInput {
  readonly typeId: string;
  readonly area: FindingArea;
  readonly severity: Severity;
  readonly status: FindingStatus;
  // The remedy's title in the report's language, with the domain filled in.
  readonly title: string;
  readonly effort: string;
  readonly minutes?: number;
  readonly role: ReportRole;
  // The colleague on that desk, when one has joined.
  readonly owner?: string;
  readonly closedAt?: string;
  readonly citations: readonly Citation[];
}

export interface ReportUndetermined {
  readonly typeId: string;
  readonly area: FindingArea;
  readonly reason: string;
}

// A quoted article (V-03): the paragraph whole, with the quotation it was fetched as,
// so the renderer can check what it draws against the entry, character for character.
export interface ReportArticle {
  readonly key: string;
  readonly reference: string;
  readonly text: string;
  readonly sourceUrl: string;
  readonly corpusVersion: string;
  readonly textAsOf: string;
  readonly quotation: Quotation;
}

export class ReportNotVerbatim extends Error {
  constructor(
    public readonly article: ReportArticle,
    public readonly failure: VerbatimFailure,
  ) {
    super(`${article.key} is not verbatim (${failure.reason}): ${failure.detail}`);
    this.name = 'ReportNotVerbatim';
  }
}

// Every article against its entry; a report is not rendered with a quotation that
// was shortened, dotted, annotated or otherwise touched.
export function assertVerbatimArticles(articles: readonly ReportArticle[]): void {
  for (const a of articles) {
    const check = verbatim(a.text, a.quotation);
    if (!check.ok) throw new ReportNotVerbatim(a, check);
  }
}

export interface ReportDecision {
  readonly key: string;
  readonly reference: string;
  readonly title: string;
}

// One answer the advisor gave (V-02): the answer, the facts of the case it rests on
// (each with the pointer that placed it), and the law it quotes, kept apart.
export interface ReportAdvice {
  readonly question: string;
  readonly at: string;
  readonly answer: string;
  readonly refused?: string;
  readonly settle?: string;
  readonly caseSays: readonly {
    readonly label: string;
    readonly value: string;
    readonly pointer: string;
  }[];
  readonly lawSays: readonly {
    readonly key: string;
    readonly reference: string;
    readonly quote: string;
  }[];
}

export interface ReportInput {
  readonly caseId: string;
  readonly domain: string;
  readonly legalName?: string;
  readonly caseUrl: string;
  readonly generatedAt: string;
  readonly findings: readonly ReportFindingInput[];
  readonly undetermined: readonly ReportUndetermined[];
  // Areas the scanner can check from outside, and did: a scan completed.
  readonly coveredAreas: readonly FindingArea[];
  readonly scanned: boolean;
  readonly articles: readonly ReportArticle[];
  readonly decisions: readonly ReportDecision[];
  readonly advice?: readonly ReportAdvice[];
}

export interface MatrixRow {
  readonly area: FindingArea;
  readonly areaLabel: string;
  readonly state: AreaState;
  readonly stateLabel: string;
  readonly note: string;
}

export interface ActionRow {
  readonly n: number;
  readonly what: string;
  readonly who: string;
  readonly effort: string;
  readonly ref: string;
  readonly severity: Severity;
}

export interface ReportModel {
  readonly locale: Locale;
  readonly caseId: string;
  readonly title: string;
  readonly subject: string;
  readonly generated: string;
  readonly generatedLabel: string;
  readonly standing: string;
  readonly liveLabel: string;
  readonly caseUrl: string;
  readonly summary: string;
  readonly sections: Record<keyof typeof REPORT_CONTENT.sections, string>;
  readonly columns: Record<keyof typeof REPORT_CONTENT.columns, string>;
  readonly matrix: readonly MatrixRow[];
  readonly actions: readonly ActionRow[];
  readonly articles: readonly (ReportArticle & {
    readonly sourceLabel: string;
    readonly asOfLabel: string;
  })[];
  readonly decisions: readonly ReportDecision[];
  readonly advice: readonly ReportAdvice[];
  readonly disclaimer: string;
  // The page footer template, with {{p}} and {{n}}; the renderer fills it per page.
  readonly page: string;
}

export interface ReportOptions {
  readonly locale: Locale;
  readonly timeZone?: string;
}

export const fillTemplate = (template: string, values: Record<string, unknown>): string =>
  template.replace(/\{\{([a-zA-Z]+)\}\}/g, (_, key: string) => String(values[key] ?? ''));

const isOpen = (status: FindingStatus) => status !== 'closed';
const rank = (s: Severity) => SEVERITIES.indexOf(s);

// The plan's own order (U-03): worst first, then by type, so the report and the page agree.
export const planOrder = <T extends { severity: Severity; typeId: string }>(a: T, b: T) =>
  rank(a.severity) - rank(b.severity) || a.typeId.localeCompare(b.typeId);

export function reportModel(input: ReportInput, options: ReportOptions): ReportModel {
  assertVerbatimArticles(input.articles);
  const { locale } = options;
  const L = (text: Parameters<typeof localise>[0]) => localise(text, locale).value;
  const C = REPORT_CONTENT;
  const format = new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : locale, {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: options.timeZone ?? 'Europe/Copenhagen',
  });
  const generated = format.format(new Date(input.generatedAt));

  const matrix: MatrixRow[] = FINDING_AREAS.map((area) => {
    const inArea = input.findings.filter((f) => f.area === area);
    const open = inArea.filter((f) => isOpen(f.status));
    const undetermined = input.undetermined.filter((u) => u.area === area);
    let state: AreaState;
    let note: string;
    if (open.length > 0) {
      state = 'open';
      note = fillTemplate(L(C.notes.open), {
        n: open.length,
        types: [...open]
          .sort(planOrder)
          .map((f) => f.typeId)
          .join(', '),
      });
    } else if (undetermined.length > 0) {
      state = 'undetermined';
      note = undetermined.map((u) => u.reason).join(' · ');
    } else if (inArea.length > 0) {
      state = 'done';
      note = fillTemplate(L(C.notes.fixed), { n: inArea.length });
    } else if (input.scanned && input.coveredAreas.includes(area)) {
      state = 'done';
      note = L(C.notes.nothingFound);
    } else {
      state = 'undetermined';
      note = L(C.notes.notChecked);
    }
    return { area, areaLabel: L(C.areas[area]), state, stateLabel: L(C.states[state]), note };
  });

  const actions: ActionRow[] = [...input.findings]
    .filter((f) => isOpen(f.status))
    .sort(planOrder)
    .map((f, i) => ({
      n: i + 1,
      what: f.title,
      who: f.owner ? `${L(C.roles[f.role])} · ${f.owner}` : L(C.roles[f.role]),
      effort: f.effort || L(C.unknownEffort),
      ref: f.typeId,
      severity: f.severity,
    }));

  const closed = input.findings.filter((f) => !isOpen(f.status)).length;
  const summary = fillTemplate(L(C.summary), {
    closed,
    total: input.findings.length,
    openAreas: matrix.filter((r) => r.state === 'open').length,
    undeterminedAreas: matrix.filter((r) => r.state === 'undetermined').length,
  });

  const key = <K extends string>(rec: Record<K, Parameters<typeof localise>[0]>) =>
    Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, L(v as never)])) as Record<
      K,
      string
    >;

  return {
    locale,
    caseId: input.caseId,
    title: L(C.title),
    subject: input.legalName ? `${input.legalName} · ${input.domain}` : input.domain,
    generated,
    generatedLabel: L(C.generated),
    standing: L(C.standing),
    liveLabel: L(C.live),
    caseUrl: input.caseUrl,
    summary,
    sections: key(C.sections),
    columns: key(C.columns),
    matrix,
    actions,
    articles: [...input.articles]
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((a) => ({
        ...a,
        sourceLabel: L(C.source),
        asOfLabel: fillTemplate(L(C.asOf), { date: a.textAsOf }),
      })),
    decisions: [...input.decisions].sort((a, b) => a.key.localeCompare(b.key)),
    advice: [...(input.advice ?? [])].sort((a, b) => a.at.localeCompare(b.at)),
    disclaimer: L(C.disclaimer),
    page: L(C.page),
  };
}
