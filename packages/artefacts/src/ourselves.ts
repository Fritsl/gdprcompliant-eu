import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { localise } from '@gc/i18n';
import { LocalisedTextSchema, type Locale } from '@gc/contracts';

// Our own record (O-01): what the service processes, who processes it for us, the
// public sources it reads, how long everything is kept and how it is deleted. The
// sources are checked against the declared endpoints and the processors against the
// configuration, so the published page cannot drift from what actually runs.

const Country = z.union([z.literal('EU'), z.string().regex(/^[A-Z]{2}$/)]);

export const OurProcessorSchema = z.object({
  purpose: z.enum(['hosting', 'database', 'model', 'embedding', 'mail', 'webhook']),
  label: LocalisedTextSchema,
  receives: LocalisedTextSchema,
  status: z.enum(['contracted', 'pending']),
  entity: z.string().min(1).nullable(),
  host: z.string().optional(),
  country: Country,
  basis: z.string().min(1),
});
export type OurProcessor = z.infer<typeof OurProcessorSchema>;

export const OurSourceSchema = z.object({
  host: z.string().min(1),
  purpose: z.enum(['corpus', 'registry', 'store']),
  entity: z.string().min(1),
  country: Country,
});
export type OurSource = z.infer<typeof OurSourceSchema>;

export const OurselvesSchema = z.object({
  version: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  controller: z.object({ name: z.string().min(1), contact: z.string().min(3), country: Country }),
  headings: z.record(z.string(), LocalisedTextSchema),
  processing: z
    .array(z.object({ id: z.string(), what: LocalisedTextSchema, basis: LocalisedTextSchema }))
    .min(1),
  processors: z.array(OurProcessorSchema).min(1),
  sources: z.object({ note: LocalisedTextSchema, hosts: z.array(OurSourceSchema) }),
  deletion: z.object({ steps: z.array(LocalisedTextSchema).min(1) }),
});
export type Ourselves = z.infer<typeof OurselvesSchema>;

export const OURSELVES_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../content/ourselves.json',
);

export function loadOurselves(file: string = OURSELVES_FILE): Ourselves {
  return OurselvesSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}

export interface DeclaredEndpoint {
  readonly host: string;
  readonly purpose: string;
  readonly jurisdiction: string;
}

export interface ConfiguredService {
  readonly purpose: OurProcessor['purpose'];
  readonly host: string;
}

// The published record against what is configured: every declared source host is
// listed with who runs it, nothing is listed that is not declared, every configured
// service has an entry with a host that matches, and in production nothing is pending.
export function auditOurselves(
  record: Ourselves,
  endpoints: readonly DeclaredEndpoint[],
  services: readonly ConfiguredService[] = [],
  production = false,
): string[] {
  const problems: string[] = [];
  const sourcePurposes = new Set(['corpus', 'registry', 'store']);
  const listed = new Map(record.sources.hosts.map((h) => [h.host, h]));
  for (const e of endpoints) {
    if (!sourcePurposes.has(e.purpose)) continue;
    const l = listed.get(e.host);
    if (!l) problems.push(`${e.host} (${e.purpose}) is declared but not published`);
    else if (l.purpose !== e.purpose)
      problems.push(`${e.host} is declared as ${e.purpose} but published as ${l.purpose}`);
    else if (l.country !== e.jurisdiction && !(l.country === 'EU' && e.jurisdiction === 'EU'))
      problems.push(`${e.host} is declared in ${e.jurisdiction} but published in ${l.country}`);
  }
  const declared = new Set(endpoints.map((e) => e.host));
  for (const h of record.sources.hosts)
    if (!declared.has(h.host))
      problems.push(`${h.host} is published but not declared as an endpoint`);
  for (const s of services) {
    const p = record.processors.find((x) => x.purpose === s.purpose);
    if (!p)
      problems.push(`the ${s.purpose} at ${s.host} is configured but has no published processor`);
    else if (p.status === 'contracted' && p.host !== s.host)
      problems.push(
        `the ${s.purpose} is published as ${p.host ?? '(no host)'} but configured as ${s.host}`,
      );
  }
  for (const p of record.processors) {
    if (p.status === 'contracted' && (!p.entity || !p.host))
      problems.push(`the ${p.purpose} processor is contracted but names no entity or host`);
    if (production && p.status === 'pending')
      problems.push(`the ${p.purpose} processor is still pending in production`);
    if (p.country !== 'EU' && !/^[A-Z]{2}$/.test(p.country))
      problems.push(`the ${p.purpose} processor has no country`);
  }
  return problems;
}

export interface RetentionLine {
  readonly table: string;
  readonly rule: string;
}

// The retention rules as the database declares them, in words a reader follows.
export function retentionLines(
  retention: Readonly<Record<string, { readonly kind: string; readonly [k: string]: unknown }>>,
  locale: Locale,
): RetentionLine[] {
  const words: Record<string, Record<string, string>> = {
    shared_reference: {
      en: 'reference data shared by every tenant; no personal data; kept',
      da: 'referencedata delt af alle lejere; ingen personoplysninger; gemmes',
      de: 'Referenzdaten, die alle Mandanten teilen; keine personenbezogenen Daten; bleibt',
    },
    with_case: {
      en: 'with the case: gone when the case is deleted or expires',
      da: 'med sagen: væk, når sagen slettes eller udløber',
      de: 'mit dem Fall: weg, wenn der Fall gelöscht wird oder abläuft',
    },
    case: {
      en: 'claimed: until its owner deletes it; unclaimed: expires after {unclaimedDays} days and is purged {graceDays} days later',
      da: 'overtaget: indtil ejeren sletter den; ikke overtaget: udløber efter {unclaimedDays} dage og slettes {graceDays} dage senere',
      de: 'übernommen: bis der Inhaber ihn löscht; nicht übernommen: läuft nach {unclaimedDays} Tagen ab und wird {graceDays} Tage später gelöscht',
    },
    months: {
      en: '{months} months from {from}, then deleted',
      da: '{months} måneder fra {from}, derefter slettet',
      de: '{months} Monate ab {from}, dann gelöscht',
    },
    claim: {
      en: 'until used or expired, then {tailDays} days',
      da: 'indtil brugt eller udløbet, derefter {tailDays} dage',
      de: 'bis benutzt oder abgelaufen, dann {tailDays} Tage',
    },
    anonymous_forever: {
      en: 'anonymous by construction; kept so a deletion can be shown to have happened',
      da: 'anonym af natur; gemmes, så en sletning kan vises at være sket',
      de: 'anonym von Grund auf; bleibt, damit eine Löschung nachweisbar ist',
    },
  };
  return Object.entries(retention)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([table, rule]) => {
      const template = words[rule.kind]?.[locale] ?? words[rule.kind]?.['en'] ?? rule.kind;
      const text = template.replace(/\{(\w+)\}/g, (_, k: string) => String(rule[k] ?? ''));
      return { table, rule: text };
    });
}

export interface OurselvesDocumentInput {
  readonly record: Ourselves;
  readonly endpoints: readonly DeclaredEndpoint[];
  readonly retention: Readonly<
    Record<string, { readonly kind: string; readonly [k: string]: unknown }>
  >;
  readonly locale: Locale;
  // Where our own case's public progress page lives, once it is published.
  readonly ownCaseUrl?: string | undefined;
  readonly generatedAt?: string | undefined;
}

// The record as a document, in the reader's language, from the configuration as it is.
export function ourselvesDocument(input: OurselvesDocumentInput): string {
  const { record, locale } = input;
  const t = (x: Parameters<typeof localise>[0]) => localise(x, locale).value;
  const h = (k: string) => t(record.headings[k] ?? { en: k });
  const lines: string[] = [];
  lines.push(`# ${h('title')}`, '', t(record.headings['lead'] ?? { en: '' }), '');
  lines.push(
    `${record.controller.name} · ${record.controller.contact} · ${record.controller.country}`,
    '',
  );
  if (input.generatedAt) lines.push(`_${input.generatedAt}_`, '');
  lines.push(`## ${h('processing')}`, '');
  for (const p of record.processing) lines.push(`- ${t(p.what)} (${h('basis')}: ${t(p.basis)})`);
  lines.push('', `## ${h('processors')}`, '');
  for (const p of record.processors) {
    const who =
      p.status === 'contracted' && p.entity
        ? `${p.entity}${p.host ? ` (${p.host})` : ''}, ${p.country}`
        : `${h('pending')}, ${p.country}`;
    lines.push(
      `- **${t(p.label)}**: ${who}. ${h('receives')}: ${t(p.receives)}. ${h('basis')}: ${p.basis}.`,
    );
  }
  lines.push('', `## ${h('sources')}`, '', t(record.sources.note), '');
  const declared = new Set(input.endpoints.map((e) => e.host));
  for (const s of record.sources.hosts.filter((x) => declared.has(x.host)))
    lines.push(`- ${s.host}: ${s.entity}, ${s.country} (${s.purpose})`);
  lines.push('', `## ${h('retention')}`, '', `| ${h('table')} | ${h('rule')} |`, '| --- | --- |');
  for (const r of retentionLines(input.retention, locale)) lines.push(`| ${r.table} | ${r.rule} |`);
  lines.push('', `## ${h('deletion')}`, '');
  record.deletion.steps.forEach((s, i) => lines.push(`${i + 1}. ${t(s)}`));
  if (input.ownCaseUrl) lines.push('', `## ${h('ownCase')}`, '', input.ownCaseUrl);
  return lines.join('\n') + '\n';
}
