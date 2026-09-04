import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  LocalisedTextSchema,
  type Company,
  type CookieClassification,
  type Locale,
  type LocalisedText,
  type RegisterRow,
} from '@gc/contracts';
import { localise } from '@gc/i18n';
import { disclaimerText } from './disclaimer.js';
import { registerTerm } from './register.js';

// The privacy policy and the cookie declaration (G-02), written from the graph. Every
// sentence is a template filled from a confirmed register row, an answer or a cookie
// read from the site, and carries the ids of the rows it came from in a trace comment.
// Where the register has a gap, nothing is written: the gaps are named instead.

const L = LocalisedTextSchema;
const Section = z.object({
  heading: L,
  body: L.optional(),
  activity: L.optional(),
  none: L.optional(),
});
const ContentSchema = z.object({
  policy: z.object({
    title: L,
    intro: L,
    sections: z.record(z.string(), Section),
    law: L,
  }),
  cookies: z.object({
    title: L,
    intro: L,
    categories: z.record(z.string(), L),
    columns: z.record(z.string(), L),
    session: L,
    days: L,
    source: L,
  }),
  gaps: z.record(z.string(), L),
});
export type PolicyContent = z.infer<typeof ContentSchema>;

export const POLICY_CONTENT_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'content',
  'policy.json',
);
export const POLICY_CONTENT: PolicyContent = ContentSchema.parse(
  JSON.parse(readFileSync(POLICY_CONTENT_FILE, 'utf8')),
);

// The Article 13 elements, in the order a reader meets them; the same ids the clause
// analysis (S-10) labels, so a generated policy and a scanned one are compared like
// for like (G-05).
export const POLICY_SECTIONS = [
  'controller',
  'dpo',
  'purposes_basis',
  'legitimate_interests',
  'recipients',
  'transfers',
  'retention',
  'rights',
  'withdrawal',
  'complaint',
  'obligation',
  'automated',
] as const;

export interface DocumentGap {
  readonly code: keyof PolicyContent['gaps'] | string;
  readonly text: string;
  readonly activityId?: string;
  readonly cookie?: string;
}

export interface Statement {
  readonly section: string;
  readonly text: string;
  // The graph rows and answers the sentence came from.
  readonly trace: readonly string[];
}

export type GeneratedDocument =
  | { readonly ok: true; readonly markdown: string; readonly statements: readonly Statement[] }
  | { readonly ok: false; readonly gaps: readonly DocumentGap[] };

export interface ContactAnswers {
  readonly address?: string;
  readonly email?: string;
  readonly dpo?: string;
  // The answer ids the values came from, for the trace.
  readonly trace: readonly string[];
}

export interface PolicyInput {
  readonly rows: readonly RegisterRow[];
  readonly company: Company;
  readonly contact: ContactAnswers;
  readonly locale: Locale;
  readonly authority: { readonly name: string; readonly url?: string };
  readonly generatedAt: Date;
}

const fill = (template: string, values: Record<string, string>) =>
  template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => values[k] ?? '');

const joinList = (items: readonly string[]) => items.join('; ');

function gapText(
  content: PolicyContent,
  code: string,
  locale: Locale,
  values: Record<string, string> = {},
) {
  const entry = content.gaps[code];
  return entry ? fill(localise(entry, locale).value, values) : code;
}

// What the register still lacks before a policy can be written.
export function policyGaps(input: PolicyInput): DocumentGap[] {
  const C = POLICY_CONTENT;
  const { locale } = input;
  const gaps: DocumentGap[] = [];
  const confirmed = input.rows.filter((r) => !r.draft);
  if (confirmed.length === 0)
    gaps.push({ code: 'no_confirmed_activity', text: gapText(C, 'no_confirmed_activity', locale) });
  for (const r of input.rows) {
    const activity = registerTerm('activities', r.name, locale);
    if (r.draft)
      gaps.push({
        code: 'draft_activity',
        text: gapText(C, 'draft_activity', locale, { activity }),
        activityId: r.activityId,
      });
    else {
      if (r.legalBases.length === 0)
        gaps.push({
          code: 'no_basis',
          text: gapText(C, 'no_basis', locale, { activity }),
          activityId: r.activityId,
        });
      if (typeof r.attributes['retention'] !== 'string' || !r.attributes['retention'])
        gaps.push({
          code: 'no_retention',
          text: gapText(C, 'no_retention', locale, { activity }),
          activityId: r.activityId,
        });
    }
  }
  if (!input.contact.address || !input.contact.email)
    gaps.push({ code: 'no_contact', text: gapText(C, 'no_contact', locale) });
  return gaps;
}

export function privacyPolicyDocument(input: PolicyInput): GeneratedDocument {
  const gaps = policyGaps(input);
  if (gaps.length > 0) return { ok: false, gaps };
  const C = POLICY_CONTENT.policy;
  const { locale } = input;
  const t = (x: LocalisedText) => localise(x, locale).value;
  const rows = input.rows.filter((r) => !r.draft);
  const company = input.company.legalName ?? input.company.domain;
  const contact = {
    company,
    domain: input.company.domain,
    address: input.contact.address!,
    email: input.contact.email!,
  };
  const statements: Statement[] = [];
  const say = (section: string, text: string, trace: readonly string[]) =>
    statements.push({ section, text, trace });
  const name = (r: RegisterRow) => registerTerm('activities', r.name, locale);
  const rowTrace = (r: RegisterRow) => [r.activityId];

  say('intro', fill(t(C.intro), contact), ['case:company']);
  const S = C.sections;
  say('controller', fill(t(S['controller']!.body!), contact), input.contact.trace);
  say(
    'dpo',
    input.contact.dpo ? fill(t(S['dpo']!.body!), { dpo: input.contact.dpo }) : t(S['dpo']!.none!),
    input.contact.trace,
  );
  for (const r of rows) {
    say(
      'purposes_basis',
      fill(t(S['purposes_basis']!.activity!), {
        activity: name(r),
        purposes: joinList(r.purposes.map((p) => registerTerm('purposes', p, locale))),
        categories: joinList(r.dataCategories.map((c) => registerTerm('categories', c, locale))),
        bases: joinList(r.legalBases.map((b) => registerTerm('bases', b, locale))),
      }),
      rowTrace(r),
    );
  }
  for (const r of rows.filter((r) => r.legalBases.includes('legitimate_interest'))) {
    say(
      'legitimate_interests',
      fill(t(S['legitimate_interests']!.activity!), {
        activity: name(r),
        purposes: joinList(r.purposes.map((p) => registerTerm('purposes', p, locale))),
      }),
      rowTrace(r),
    );
  }
  const withRecipients = rows.filter((r) => r.recipients.length > 0);
  if (withRecipients.length === 0)
    say(
      'recipients',
      t(S['recipients']!.none!),
      rows.map((r) => r.activityId),
    );
  for (const r of withRecipients) {
    say(
      'recipients',
      fill(t(S['recipients']!.activity!), {
        activity: name(r),
        recipients: joinList(
          r.recipients.map((x) => (x.country ? `${x.name} (${x.country})` : x.name)),
        ),
      }),
      [r.activityId, ...r.recipients.map((x) => x.nodeId)],
    );
  }
  const transfers = rows.flatMap((r) => r.transfers.map((x) => ({ row: r, transfer: x })));
  if (transfers.length === 0)
    say(
      'transfers',
      t(S['transfers']!.none!),
      rows.map((r) => r.activityId),
    );
  for (const { row, transfer } of transfers) {
    const statement = transfer.attributes['statement'] as Record<string, string> | undefined;
    say(
      'transfers',
      `${name(row)}, ${transfer.vendor}: ${statement?.[locale] ?? statement?.['en'] ?? ''}`.trim(),
      [row.activityId, transfer.nodeId],
    );
  }
  for (const r of rows) {
    say(
      'retention',
      fill(t(S['retention']!.activity!), {
        activity: name(r),
        retention: String(r.attributes['retention']),
      }),
      rowTrace(r),
    );
  }
  say('rights', fill(t(S['rights']!.body!), contact), input.contact.trace);
  const consentRows = rows.filter((r) =>
    r.legalBases.some((b) => b === 'consent' || b === 'explicit_consent'),
  );
  if (consentRows.length > 0)
    say(
      'withdrawal',
      fill(t(S['withdrawal']!.body!), { ...contact, activities: consentRows.map(name).join(', ') }),
      consentRows.map((r) => r.activityId),
    );
  say(
    'complaint',
    fill(t(S['complaint']!.body!), {
      authority: input.authority.name,
      authorityUrl: input.authority.url ? ` (${input.authority.url})` : '',
    }),
    ['binding:authority'],
  );
  const contractRows = rows.filter((r) => r.legalBases.includes('contract'));
  say(
    'obligation',
    contractRows.length > 0
      ? fill(t(S['obligation']!.body!), { activities: contractRows.map(name).join(', ') })
      : t(S['obligation']!.none!),
    contractRows.length > 0 ? contractRows.map((r) => r.activityId) : rows.map((r) => r.activityId),
  );
  say(
    'automated',
    t(S['automated']!.body!),
    rows.map((r) => r.activityId),
  );

  const lines: string[] = [`# ${t(C.title)}`, ''];
  let current = '';
  for (const s of statements) {
    if (s.section !== current && s.section !== 'intro') {
      current = s.section;
      lines.push(`## ${t(S[current]!.heading)}`, '');
    }
    lines.push(s.text, `<!-- trace: ${s.trace.join(', ')} -->`, '');
  }
  lines.push('---', '', disclaimerText(locale), '');
  return { ok: true, markdown: lines.join('\n'), statements };
}

export interface ObservedCookie {
  readonly name: string;
  readonly domain: string;
  // Seconds from the read to expiry; absent for a session cookie.
  readonly maxAgeSeconds?: number;
  readonly classification: CookieClassification;
  readonly evidenceId: string;
}

export interface CookieDeclarationInput {
  readonly cookies: readonly ObservedCookie[];
  readonly company: Company;
  readonly locale: Locale;
  readonly generatedAt: Date;
}

export function cookieGaps(input: CookieDeclarationInput): DocumentGap[] {
  const C = POLICY_CONTENT;
  const gaps: DocumentGap[] = [];
  if (input.cookies.length === 0)
    gaps.push({ code: 'no_cookies', text: gapText(C, 'no_cookies', input.locale) });
  for (const c of input.cookies) {
    if (c.classification.resolution !== 'matched')
      gaps.push({
        code: 'unknown_cookie',
        text: gapText(C, 'unknown_cookie', input.locale, { name: c.name }),
        cookie: c.name,
      });
  }
  return gaps;
}

export function cookieDeclarationDocument(input: CookieDeclarationInput): GeneratedDocument {
  const gaps = cookieGaps(input);
  if (gaps.length > 0) return { ok: false, gaps };
  const C = POLICY_CONTENT.cookies;
  const { locale } = input;
  const t = (x: LocalisedText) => localise(x, locale).value;
  const statements: Statement[] = [];
  const lines: string[] = [`# ${t(C.title)}`, ''];
  const intro = fill(t(C.intro), {
    domain: input.company.domain,
    date: input.generatedAt.toISOString().slice(0, 10),
  });
  statements.push({ section: 'intro', text: intro, trace: input.cookies.map((c) => c.evidenceId) });
  lines.push(intro, `<!-- trace: ${input.cookies.map((c) => c.evidenceId).join(', ')} -->`, '');
  const order = [
    'necessary',
    'functional',
    'analytics',
    'marketing',
    'personalisation',
    'security',
  ];
  for (const category of order) {
    const inCategory = input.cookies.filter((c) => c.classification.category === category);
    if (inCategory.length === 0) continue;
    lines.push(`## ${t(C.categories[category]!)}`, '');
    lines.push(
      `| ${t(C.columns['name']!)} | ${t(C.columns['provider']!)} | ${t(C.columns['purpose']!)} | ${t(C.columns['expiry']!)} |`,
    );
    lines.push('| --- | --- | --- | --- |');
    for (const c of [...inCategory].sort((a, b) => a.name.localeCompare(b.name))) {
      const m = c.classification.match!;
      const expiry =
        c.maxAgeSeconds === undefined
          ? t(C.session)
          : fill(t(C.days), { n: String(Math.max(1, Math.round(c.maxAgeSeconds / 86_400))) });
      const text = `| ${c.name} | ${m.dataController ?? m.platform} | ${m.description ?? ''} | ${expiry} |`;
      statements.push({ section: category, text, trace: [c.evidenceId] });
      lines.push(text);
    }
    lines.push(`<!-- trace: ${inCategory.map((c) => c.evidenceId).join(', ')} -->`, '');
  }
  const src = input.cookies[0]!.classification.source;
  lines.push(fill(t(C.source), { source: src.name, version: src.version.slice(0, 12) }), '');
  lines.push('---', '', disclaimerText(locale), '');
  return { ok: true, markdown: lines.join('\n'), statements };
}

// The paragraphs a reader sees: the markdown without its trace comments.
export const withoutTraces = (markdown: string): string =>
  markdown
    .split('\n')
    .filter((l) => !l.startsWith('<!-- trace:'))
    .join('\n');

// Every trace in a document, in order: what G-05 re-checks against the live site.
export const tracesOf = (markdown: string): string[][] =>
  [...markdown.matchAll(/<!-- trace: ([^>]*) -->/g)].map((m) =>
    m[1]!
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
