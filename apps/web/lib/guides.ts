import 'server-only';
import { citationKey, type Citation, type Locale } from '@gc/contracts';
import { DETECTORS, citationFromRow, loadBindingTables } from '@gc/findings';
import { LOCALE_CODES, localise } from '@gc/i18n';
import { guideLocales, loadCatalogue, loadGuides } from '@gc/remedies';
import { siteUrl } from '@/lib/site';

// The guide pages (S-15, R-03, U-06): one per finding type per locale the guide is
// written in, public, generated ahead of any request from the guide content, with the
// provisions the binding names for each supported jurisdiction and the remedy's snippet
// where there is one. The text has one home, packages/remedies/content/guides; the page
// renders it and adds nothing of its own.

const guides = loadGuides();
const catalogue = loadCatalogue();
const tables = loadBindingTables();

export interface GuideSummary {
  readonly id: string;
  readonly findingTypeId: string;
  readonly area: string;
  readonly title: string;
  // The locale the page is served in: the reader's when the guide is written in it,
  // otherwise the default. A list never links to a page that does not exist.
  readonly locale: Locale;
  readonly href: string;
}

export interface GuideView extends GuideSummary {
  readonly wrong: string;
  readonly why: string;
  readonly steps: readonly string[];
  readonly confirm: string;
  readonly keywords: readonly string[];
  readonly snippet?: string;
  readonly remedyTitle?: string;
  // Every locale the guide exists in: the hreflang set.
  readonly locales: readonly Locale[];
  // The provisions per jurisdiction, as the binding tables give them.
  readonly law: readonly { jurisdiction: string; authority: string; citations: string[] }[];
}

const area = new Map(DETECTORS.map((d) => [d.findingTypeId, d.area]));

const citationText = (c: Citation): string => {
  if (c.kind === 'provision') return `${c.instrument} ${c.ref}`;
  if (c.kind === 'decision') return `${c.body} ${c.reference}`;
  return `${c.authority}: ${c.title}`;
};

export const guidePath = (locale: Locale, id?: string): string =>
  id ? `/${locale}/guides/${id}` : `/${locale}/guides`;
export const guideUrl = (locale: Locale, id?: string): string =>
  `${siteUrl()}${guidePath(locale, id)}`;

const servedIn = (locales: readonly Locale[], locale: Locale): Locale =>
  locales.includes(locale) ? locale : 'en';

export function listGuides(locale: Locale): GuideSummary[] {
  return guides.guides
    .map((g) => {
      const served = servedIn(guideLocales(g), locale);
      return {
        id: g.id,
        findingTypeId: g.findingTypeId,
        area: area.get(g.findingTypeId) ?? '',
        title: localise(g.title, served).value,
        locale: served,
        href: guidePath(served, g.id),
      };
    })
    .sort((a, b) => a.area.localeCompare(b.area) || a.findingTypeId.localeCompare(b.findingTypeId));
}

// The guide in this locale, or nothing: a guide is never served in a language it is not
// written in.
export function guideView(id: string, locale: Locale): GuideView | undefined {
  const g = guides.byId(id);
  if (!g) return undefined;
  const locales = guideLocales(g);
  if (!locales.includes(locale)) return undefined;
  const L = (t: Parameters<typeof localise>[0]) => localise(t, locale).value;
  const remedy = g.remedyId ? catalogue.get(g.remedyId)?.remedy : undefined;
  const snippet = remedy?.kind === 'self_fix' ? remedy.snippet : undefined;
  const law = [...tables.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([jurisdiction, table]) => {
      const binding = table.bindings.find((b) => b.findingTypeId === g.findingTypeId);
      if (!binding) return [];
      return [
        {
          jurisdiction,
          authority: table.authority.name,
          citations: binding.citations.map((c) => {
            const typed = citationFromRow(c);
            return `${citationText(typed)}${c.note ? ` — ${c.note}` : ''} (${citationKey(typed)})`;
          }),
        },
      ];
    });
  return {
    id: g.id,
    findingTypeId: g.findingTypeId,
    area: area.get(g.findingTypeId) ?? '',
    title: L(g.title),
    locale,
    href: guidePath(locale, g.id),
    wrong: L(g.wrong),
    why: L(g.why),
    steps: g.steps.map((s) => L(s)),
    confirm: L(g.confirm),
    keywords: g.keywords.map((k) => L(k)),
    ...(snippet ? { snippet } : {}),
    ...(remedy ? { remedyTitle: L(remedy.title) } : {}),
    locales,
    law,
  };
}

export const guideIds = (): string[] => guides.guides.map((g) => g.id);

// Every page that exists: the static parameter set, and the sitemap's rows.
export function guidePages(): { id: string; locales: Locale[] }[] {
  return guides.guides.map((g) => ({ id: g.id, locales: guideLocales(g) }));
}

export const guideIdsIn = (locale: Locale): string[] =>
  guidePages()
    .filter((p) => p.locales.includes(locale))
    .map((p) => p.id);

// The hreflang set of a page: one entry per locale it exists in, and x-default for
// the reader whose language it is not written in.
export function languagesOf(locales: readonly Locale[], id?: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of [...locales].sort()) out[l] = guideUrl(l, id);
  out['x-default'] = guideUrl('en', id);
  return out;
}

export const allLocales = (): Locale[] => [...LOCALE_CODES];
