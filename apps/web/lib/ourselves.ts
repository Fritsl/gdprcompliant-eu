import 'server-only';
import {
  loadOurselves,
  ourselvesDocument,
  retentionLines,
  type OurProcessor,
  type OurSource,
  type Ourselves,
} from '@gc/artefacts';
import { declaredEndpoints } from '@gc/config';
import type { Locale } from '@gc/contracts';
import { RETENTION } from '@gc/db';
import { localise } from '@gc/i18n';

// Our own record (O-01), as the page shows it: read from the record, the declared
// endpoints and the database's retention rules at request time, so what is published is
// what runs. The public progress page of our own case is linked when it exists.

export interface OurselvesView {
  readonly headings: Readonly<Record<string, string>>;
  readonly controller: Ourselves['controller'];
  readonly lead: string;
  readonly processing: readonly { readonly what: string; readonly basis: string }[];
  readonly processors: readonly {
    readonly purpose: OurProcessor['purpose'];
    readonly label: string;
    readonly who: string;
    readonly receives: string;
    readonly basis: string;
    readonly pending: boolean;
  }[];
  readonly sourcesNote: string;
  readonly sources: readonly OurSource[];
  readonly retention: readonly { readonly table: string; readonly rule: string }[];
  readonly deletion: readonly string[];
  readonly ownCaseUrl?: string | undefined;
  readonly generatedAt: string;
  readonly markdown: string;
}

const ownCaseUrl = (): string | undefined => {
  const slug = process.env['OURSELVES_TRUST_SLUG'];
  const base = process.env['APP_BASE_URL'];
  return slug && base ? `${base.replace(/\/$/, '')}/en/t/${slug}` : undefined;
};

export function ourselvesView(locale: Locale, now: () => Date = () => new Date()): OurselvesView {
  const record = loadOurselves();
  const endpoints = declaredEndpoints();
  const pick = (x: Parameters<typeof localise>[0]) => localise(x, locale).value;
  const headings: Record<string, string> = {};
  for (const [k, v] of Object.entries(record.headings)) headings[k] = pick(v);
  const declared = new Set(endpoints.map((e) => e.host));
  const generatedAt = now().toISOString().slice(0, 10);
  const own = ownCaseUrl();
  return {
    headings,
    controller: record.controller,
    lead: headings['lead'] ?? '',
    processing: record.processing.map((p) => ({ what: pick(p.what), basis: pick(p.basis) })),
    processors: record.processors.map((p) => ({
      purpose: p.purpose,
      label: pick(p.label),
      who:
        p.status === 'contracted' && p.entity
          ? `${p.entity}${p.host ? ` (${p.host})` : ''}, ${p.country}`
          : `${headings['pending'] ?? 'pending'}, ${p.country}`,
      receives: pick(p.receives),
      basis: p.basis,
      pending: p.status === 'pending',
    })),
    sourcesNote: pick(record.sources.note),
    sources: record.sources.hosts.filter((h) => declared.has(h.host)),
    retention: retentionLines(RETENTION, locale),
    deletion: record.deletion.steps.map((s) => pick(s)),
    ownCaseUrl: own,
    generatedAt,
    markdown: ourselvesDocument({
      record,
      endpoints,
      retention: RETENTION,
      locale,
      ownCaseUrl: own,
      generatedAt,
    }),
  };
}
