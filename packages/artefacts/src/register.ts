import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { LocalisedTextSchema, type Company, type Locale, type RegisterRow } from '@gc/contracts';
import { localise } from '@gc/i18n';
import { disclaimerText } from './disclaimer.js';

// The record of processing activities as a document (G-01): the Article 30(1) columns
// in their order, in the case's language, one block per activity, read off the graph.
// A row the company has not confirmed is marked a draft; a column nobody has answered
// says so instead of guessing.

const L = LocalisedTextSchema;
const ContentSchema = z.object({
  title: L,
  basis: L,
  controller: L,
  generated: L,
  draft: L,
  confirmed: L,
  columns: z.record(z.string(), L),
  notYetAnswered: L,
  none: L,
  noTransfer: L,
  empty: L,
  subjects: z.record(z.string(), L),
  activities: z.record(z.string(), L),
  purposes: z.record(z.string(), L),
  categories: z.record(z.string(), L),
  bases: z.record(z.string(), L),
});
export type RegisterContent = z.infer<typeof ContentSchema>;

export const REGISTER_CONTENT_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'content',
  'register.json',
);
export const REGISTER_CONTENT: RegisterContent = ContentSchema.parse(
  JSON.parse(readFileSync(REGISTER_CONTENT_FILE, 'utf8')),
);

// The vocabulary the seeding writes into the graph is a key into this content, so the
// same row reads in every language; a person's own words pass through as written.
export function registerTerm(
  table: 'subjects' | 'activities' | 'purposes' | 'categories' | 'bases',
  key: string,
  locale: Locale,
): string {
  const entry = REGISTER_CONTENT[table][key];
  return entry ? localise(entry, locale).value : key;
}

export const COLUMN_ORDER = [
  'activity',
  'purposes',
  'dataSubjects',
  'dataCategories',
  'legalBases',
  'recipients',
  'transfers',
  'retention',
  'security',
  'evidence',
  'status',
] as const;

export interface RegisterDocumentInput {
  readonly rows: readonly RegisterRow[];
  readonly company: Company;
  readonly locale: Locale;
  readonly generatedAt: Date;
}

const list = (items: readonly string[], none: string): string =>
  items.length === 0 ? none : items.join('; ');

const term = (table: Parameters<typeof registerTerm>[0], value: string, locale: Locale) =>
  registerTerm(table, value, locale);

export function registerDocument(input: RegisterDocumentInput): string {
  const { locale } = input;
  const t = (x: Parameters<typeof localise>[0]) => localise(x, locale).value;
  const C = REGISTER_CONTENT;
  const col = (k: (typeof COLUMN_ORDER)[number]) => t(C.columns[k]!);
  const lines: string[] = [];
  lines.push(`# ${t(C.title)}`);
  lines.push('');
  lines.push(t(C.basis));
  lines.push('');
  lines.push(
    `**${t(C.controller)}:** ${input.company.legalName ?? input.company.domain} (${input.company.domain})`,
  );
  lines.push(`**${t(C.generated)}:** ${input.generatedAt.toISOString().slice(0, 10)}`);
  lines.push('');
  if (input.rows.length === 0) {
    lines.push(t(C.empty));
    lines.push('');
  }
  for (const row of input.rows) {
    const subjects = ((row.attributes['dataSubjects'] as string[] | undefined) ?? []).map((s) =>
      term('subjects', s, locale),
    );
    const retention = row.attributes['retention'];
    const security = row.attributes['security'];
    lines.push(`## ${term('activities', row.name, locale)}`);
    lines.push('');
    lines.push(`- **${col('status')}:** ${row.draft ? t(C.draft) : t(C.confirmed)}`);
    lines.push(
      `- **${col('purposes')}:** ${list(
        row.purposes.map((p) => term('purposes', p, locale)),
        t(C.none),
      )}`,
    );
    lines.push(`- **${col('dataSubjects')}:** ${list(subjects, t(C.notYetAnswered))}`);
    lines.push(
      `- **${col('dataCategories')}:** ${list(
        row.dataCategories.map((c) => term('categories', c, locale)),
        t(C.none),
      )}`,
    );
    lines.push(
      `- **${col('legalBases')}:** ${list(
        row.legalBases.map((b) => term('bases', b, locale)),
        t(C.notYetAnswered),
      )}`,
    );
    lines.push(
      `- **${col('recipients')}:** ${list(
        row.recipients.map((r) => (r.country ? `${r.name} (${r.country})` : r.name)),
        t(C.none),
      )}`,
    );
    lines.push(
      `- **${col('transfers')}:** ${list(
        row.transfers.map((x) => {
          const statement = x.attributes['statement'] as Record<string, string> | undefined;
          return statement?.[locale] ?? statement?.['en'] ?? x.vendor;
        }),
        t(C.noTransfer),
      )}`,
    );
    lines.push(
      `- **${col('retention')}:** ${typeof retention === 'string' && retention ? retention : t(C.notYetAnswered)}`,
    );
    lines.push(
      `- **${col('security')}:** ${typeof security === 'string' && security ? security : t(C.notYetAnswered)}`,
    );
    lines.push(
      `- **${col('evidence')}:** ${list(
        row.evidence.map((e) => e.evidenceId),
        t(C.none),
      )}`,
    );
    lines.push('');
  }
  lines.push('---');
  lines.push('');
  lines.push(disclaimerText(locale));
  lines.push('');
  return lines.join('\n');
}
