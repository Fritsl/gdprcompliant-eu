import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  LocalisedTextSchema,
  type AgreementElement,
  type Company,
  type Locale,
  type LocalisedText,
  type RegisterRow,
} from '@gc/contracts';
import { AGREEMENT_ELEMENTS } from '@gc/findings';
import { localise } from '@gc/i18n';
import { disclaimerText } from './disclaimer.js';
import type { ContactAnswers, DocumentGap, GeneratedDocument, Statement } from './policy.js';
import { registerTerm } from './register.js';

// The processing agreement and the sub-processor page (G-03), written from the graph.
// The agreement has one clause per element of the table a supplier's agreement is read
// against (D-06), so every clause is traceable to the requirement it satisfies: the
// trace names the element and the provision the table cites. The sub-processor page is
// the supply chain as the record holds it, every row naming the list it was read from
// and the day, so regenerating it after a list changes changes the row. Both carry a
// notice that a lawyer reads them before anyone relies on them. Where the record has a
// gap, nothing is written: the gaps are named instead.

const L = LocalisedTextSchema;
const Section = z.object({ heading: L, body: L, known: L.optional(), none: L.optional() });
const ContentSchema = z.object({
  notice: L,
  defaults: z.object({
    noticeDays: z.number().int().positive(),
    breachHours: z.number().int().positive(),
    deletionDays: z.number().int().positive(),
  }),
  agreement: z.object({
    title: L,
    intro: L,
    sections: z.record(z.string(), Section),
    annexes: z.object({
      processors: z.object({ heading: L, columns: z.record(z.string(), L) }),
      security: z.object({ heading: L, answered: L, none: L }),
      subprocessors: z.object({ heading: L, row: L, none: L }),
      clauses: z.object({ heading: L, body: L }),
    }),
    signatures: z.object({ heading: L, body: L }),
    unknownLocation: L,
  }),
  subprocessors: z.object({
    title: L,
    intro: L,
    direct: L,
    indirect: L,
    columns: z.record(z.string(), L),
    noIndirect: L,
    updates: L,
    unknownLocation: L,
  }),
  gaps: z.record(z.string(), L),
});
export type AgreementContent = z.infer<typeof ContentSchema>;

export const AGREEMENT_CONTENT_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'content',
  'agreement.json',
);
export const AGREEMENT_CONTENT: AgreementContent = ContentSchema.parse(
  JSON.parse(readFileSync(AGREEMENT_CONTENT_FILE, 'utf8')),
);

const fill = (template: string, values: Record<string, string>) =>
  template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => values[k] ?? '');
const joinList = (items: readonly string[]) => items.join('; ');
const unique = (items: readonly string[]) => [...new Set(items)];
const day = (iso: string | Date) =>
  (typeof iso === 'string' ? iso : iso.toISOString()).slice(0, 10);

function gapText(code: string, locale: Locale, values: Record<string, string> = {}) {
  const entry = AGREEMENT_CONTENT.gaps[code];
  return entry ? fill(localise(entry, locale).value, values) : code;
}

// A supplier the confirmed register names as a recipient, with the activities that
// share data with it.
export interface ProcessorInput {
  readonly nodeId: string;
  // The graph key, shared by every node that says something about this supplier.
  readonly key?: string;
  readonly name: string;
  readonly country?: string;
  readonly activities: readonly RegisterRow[];
}

// A company a supplier's published list names (D-07), as the graph holds it.
export interface SubProcessorRow {
  readonly nodeId: string;
  readonly name: string;
  readonly country?: string;
  readonly engagedBy: { readonly nodeId: string; readonly name: string; readonly key?: string };
  readonly purpose?: string;
  // The list it was read from: the page, the moment, the stored evidence.
  readonly source: string;
  readonly readOn: string;
  readonly evidenceId: string;
  // 2 for a processor's sub-processor, 3 for theirs.
  readonly level: number;
}

export interface AgreementInput {
  readonly processors: readonly ProcessorInput[];
  readonly subProcessors: readonly SubProcessorRow[];
  readonly company: Company;
  readonly contact: ContactAnswers;
  readonly locale: Locale;
  readonly generatedAt: Date;
  readonly elements?: readonly AgreementElement[];
}

// What the record still lacks before an agreement can be written.
export function agreementGaps(input: AgreementInput): DocumentGap[] {
  const { locale } = input;
  const gaps: DocumentGap[] = [];
  const rows = unique(input.processors.flatMap((p) => p.activities.map((r) => r.activityId))).map(
    (id) => input.processors.flatMap((p) => p.activities).find((r) => r.activityId === id)!,
  );
  const confirmed = rows.filter((r) => !r.draft);
  if (input.processors.length === 0) {
    gaps.push({ code: 'no_processor', text: gapText('no_processor', locale) });
  } else if (confirmed.length === 0) {
    gaps.push({ code: 'no_confirmed_activity', text: gapText('no_confirmed_activity', locale) });
  }
  for (const r of confirmed) {
    const subjects = (r.attributes['dataSubjects'] as string[] | undefined) ?? [];
    if (subjects.length === 0)
      gaps.push({
        code: 'no_subjects',
        text: gapText('no_subjects', locale, {
          activity: registerTerm('activities', r.name, locale),
        }),
        activityId: r.activityId,
      });
  }
  if (!input.contact.address || !input.contact.email)
    gaps.push({ code: 'no_contact', text: gapText('no_contact', locale) });
  return gaps;
}

const requirementTrace = (e: AgreementElement) => [
  `requirement:${e.id}`,
  `${e.citation.instrument} ${e.citation.ref}`,
];

export function processingAgreementDocument(input: AgreementInput): GeneratedDocument {
  const gaps = agreementGaps(input);
  if (gaps.length > 0) return { ok: false, gaps };
  const C = AGREEMENT_CONTENT;
  const A = C.agreement;
  const { locale } = input;
  const t = (x: LocalisedText) => localise(x, locale).value;
  const elements = input.elements ?? AGREEMENT_ELEMENTS;
  const company = input.company.legalName ?? input.company.domain;
  const processors = input.processors.filter((p) => p.activities.some((r) => !r.draft));
  const rows = unique(
    processors.flatMap((p) => p.activities.filter((r) => !r.draft).map((r) => r.activityId)),
  ).map((id) => processors.flatMap((p) => p.activities).find((r) => r.activityId === id)!);
  const rowIds = rows.map((r) => r.activityId);
  const processorIds = processors.map((p) => p.nodeId);
  const name = (r: RegisterRow) => registerTerm('activities', r.name, locale);
  const term = (table: 'purposes' | 'categories' | 'subjects', keys: readonly string[]) =>
    joinList(unique(keys).map((k) => registerTerm(table, k, locale)));
  const location = (country: string | undefined) => country ?? t(A.unknownLocation);
  const transfers = rows.flatMap((r) =>
    r.transfers.map((x) => {
      const statement = x.attributes['statement'] as Record<string, string> | undefined;
      return {
        row: r,
        transfer: x,
        text: `${x.vendor}: ${statement?.[locale] ?? statement?.['en'] ?? ''}`.trim(),
      };
    }),
  );
  const defaults = {
    noticeDays: String(C.defaults.noticeDays),
    breachHours: String(C.defaults.breachHours),
    deletionDays: String(C.defaults.deletionDays),
  };
  const values: Record<string, string> = {
    ...defaults,
    company,
    domain: input.company.domain,
    address: input.contact.address!,
    email: input.contact.email!,
    activities: joinList(rows.map(name)),
    purposes: term(
      'purposes',
      rows.flatMap((r) => r.purposes),
    ),
    categories: term(
      'categories',
      rows.flatMap((r) => r.dataCategories),
    ),
    subjects: term(
      'subjects',
      rows.flatMap((r) => (r.attributes['dataSubjects'] as string[] | undefined) ?? []),
    ),
    transfers:
      transfers.length > 0
        ? fill(t(A.sections['transfer_annex']!.known!), {
            list: joinList(transfers.map((x) => x.text)),
          })
        : t(A.sections['transfer_annex']!.none!),
  };

  const statements: Statement[] = [];
  const say = (section: string, text: string, trace: readonly string[]) =>
    statements.push({ section, text, trace });

  say('notice', t(C.notice), ['content:notice']);
  say('intro', fill(t(A.intro), values), ['case:company', ...input.contact.trace]);

  // One clause per element of the table, in the table's order. The trace names the
  // element, the provision, and the rows and answers the clause was filled from.
  const traceFor: Record<string, readonly string[]> = {
    parties: [...processorIds, 'case:company'],
    subject_and_duration: rowIds,
    nature_and_purpose: rowIds,
    data_and_subjects: rowIds,
    controller_rights: ['case:company'],
    documented_instructions: ['case:company'],
    confidentiality: processorIds,
    security_measures: rowIds,
    subprocessor_authorisation: processorIds,
    subprocessor_objection: ['content:defaults'],
    assist_data_subject_rights: processorIds,
    assist_obligations: processorIds,
    breach_notification: ['content:defaults'],
    deletion_or_return: ['content:defaults'],
    audits: processorIds,
    transfer_annex:
      transfers.length > 0
        ? transfers.flatMap((x) => [x.row.activityId, x.transfer.nodeId])
        : rowIds,
  };
  for (const e of elements) {
    const section = A.sections[e.id];
    if (!section) throw new Error(`agreement content has no clause for element ${e.id}`);
    say(e.id, fill(t(section.body), values), [
      ...requirementTrace(e),
      ...(traceFor[e.id] ?? ['case:company']),
    ]);
  }

  // Annex 1: the processors and what each processes, from the confirmed rows.
  const X = A.annexes;
  const col = (k: string) => t(X.processors.columns[k]!);
  say(
    'annex_processors',
    `| ${col('processor')} | ${col('location')} | ${col('activities')} | ${col('purposes')} | ${col('categories')} | ${col('subjects')} |\n| --- | --- | --- | --- | --- | --- |`,
    processorIds,
  );
  for (const p of processors) {
    const mine = p.activities.filter((r) => !r.draft);
    say(
      'annex_processors',
      `| ${p.name} | ${location(p.country)} | ${joinList(mine.map(name))} | ${term(
        'purposes',
        mine.flatMap((r) => r.purposes),
      )} | ${term(
        'categories',
        mine.flatMap((r) => r.dataCategories),
      )} | ${term(
        'subjects',
        mine.flatMap((r) => (r.attributes['dataSubjects'] as string[] | undefined) ?? []),
      )} |`,
      [p.nodeId, ...mine.map((r) => r.activityId)],
    );
  }
  // Annex 2: the measures the record answered, per activity, or what stands in for them.
  const withSecurity = rows.filter(
    (r) => typeof r.attributes['security'] === 'string' && r.attributes['security'],
  );
  if (withSecurity.length === 0) say('annex_security', t(X.security.none), rowIds);
  for (const r of withSecurity)
    say(
      'annex_security',
      fill(t(X.security.answered), {
        activity: name(r),
        security: String(r.attributes['security']),
      }),
      [r.activityId],
    );
  // Annex 3: the sub-processors the suppliers' own lists name, with where and when.
  const authorised = input.subProcessors.filter((s) =>
    processors.some(
      (p) => p.nodeId === s.engagedBy.nodeId || (p.key !== undefined && p.key === s.engagedBy.key),
    ),
  );
  if (authorised.length === 0) say('annex_subprocessors', t(X.subprocessors.none), processorIds);
  for (const s of authorised)
    say(
      'annex_subprocessors',
      fill(t(X.subprocessors.row), {
        processor: s.engagedBy.name,
        name: s.name,
        location: location(s.country),
        source: s.source,
        date: day(s.readOn),
      }),
      [s.engagedBy.nodeId, s.nodeId, s.evidenceId],
    );
  say('annex_clauses', t(X.clauses.body), ['content:annex']);
  say('signatures', fill(t(A.signatures.body), values), ['case:company']);

  const headings: Record<string, LocalisedText> = {
    annex_processors: X.processors.heading,
    annex_security: X.security.heading,
    annex_subprocessors: X.subprocessors.heading,
    annex_clauses: X.clauses.heading,
    signatures: A.signatures.heading,
  };
  for (const e of elements) headings[e.id] = A.sections[e.id]!.heading;

  const lines: string[] = [`# ${t(A.title)}`, ''];
  let current = '';
  for (const s of statements) {
    if (s.section === 'notice') {
      lines.push(`> ${s.text}`, `<!-- trace: ${s.trace.join(', ')} -->`, '');
      continue;
    }
    if (s.section !== current && s.section !== 'intro') {
      current = s.section;
      lines.push(`## ${t(headings[current]!)}`, '');
    }
    lines.push(s.text, `<!-- trace: ${s.trace.join(', ')} -->`, '');
  }
  lines.push('---', '', disclaimerText(locale), '');
  return { ok: true, markdown: lines.join('\n'), statements };
}

// ---- the sub-processor page ---------------------------------------------------------------

export interface SubProcessorPageInput {
  readonly processors: readonly ProcessorInput[];
  readonly subProcessors: readonly SubProcessorRow[];
  readonly company: Company;
  readonly locale: Locale;
  readonly generatedAt: Date;
}

export function subProcessorGaps(input: SubProcessorPageInput): DocumentGap[] {
  return input.processors.length === 0 && input.subProcessors.length === 0
    ? [{ code: 'no_vendors', text: gapText('no_vendors', input.locale) }]
    : [];
}

export function subProcessorListDocument(input: SubProcessorPageInput): GeneratedDocument {
  const gaps = subProcessorGaps(input);
  if (gaps.length > 0) return { ok: false, gaps };
  const C = AGREEMENT_CONTENT;
  const S = C.subprocessors;
  const { locale } = input;
  const t = (x: LocalisedText) => localise(x, locale).value;
  const col = (k: string) => t(S.columns[k]!);
  const company = input.company.legalName ?? input.company.domain;
  const location = (country: string | undefined) => country ?? t(S.unknownLocation);
  const statements: Statement[] = [];
  const say = (section: string, text: string, trace: readonly string[]) =>
    statements.push({ section, text, trace });

  say('notice', t(C.notice), ['content:notice']);
  say(
    'intro',
    fill(t(S.intro), { company, domain: input.company.domain, date: day(input.generatedAt) }),
    ['case:company'],
  );
  const processors = [...input.processors].sort((a, b) => a.name.localeCompare(b.name));
  say(
    'direct',
    `| ${col('name')} | ${col('location')} | ${col('activities')} |\n| --- | --- | --- |`,
    processors.map((p) => p.nodeId),
  );
  for (const p of processors)
    say(
      'direct',
      `| ${p.name} | ${location(p.country)} | ${p.activities
        .map((r) => registerTerm('activities', r.name, locale))
        .join('; ')} |`,
      [p.nodeId, ...p.activities.map((r) => r.activityId)],
    );
  const indirect = [...input.subProcessors].sort(
    (a, b) =>
      a.level - b.level ||
      a.engagedBy.name.localeCompare(b.engagedBy.name) ||
      a.name.localeCompare(b.name),
  );
  if (indirect.length === 0)
    say(
      'indirect',
      t(S.noIndirect),
      processors.map((p) => p.nodeId),
    );
  else
    say(
      'indirect',
      `| ${col('name')} | ${col('location')} | ${col('engagedBy')} | ${col('purpose')} | ${col('readOn')} | ${col('source')} |\n| --- | --- | --- | --- | --- | --- |`,
      indirect.map((s) => s.nodeId),
    );
  for (const s of indirect)
    say(
      'indirect',
      `| ${s.name} | ${location(s.country)} | ${s.engagedBy.name} | ${s.purpose ?? ''} | ${day(s.readOn)} | ${s.source} |`,
      [s.nodeId, s.engagedBy.nodeId, s.evidenceId],
    );
  say('updates', t(S.updates), ['content:updates']);

  const headings: Record<string, LocalisedText> = { direct: S.direct, indirect: S.indirect };
  const lines: string[] = [`# ${t(S.title)}`, ''];
  let current = '';
  for (const s of statements) {
    if (s.section === 'notice') {
      lines.push(`> ${s.text}`, `<!-- trace: ${s.trace.join(', ')} -->`, '');
      continue;
    }
    if (headings[s.section] && s.section !== current) {
      current = s.section;
      lines.push(`## ${t(headings[current]!)}`, '');
    }
    lines.push(s.text, `<!-- trace: ${s.trace.join(', ')} -->`, '');
  }
  lines.push('---', '', disclaimerText(locale), '');
  return { ok: true, markdown: lines.join('\n'), statements };
}
