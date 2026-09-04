import 'server-only';
import { citationKey, type Citation, type Locale } from '@gc/contracts';
import { DETECTORS, citationFromRow, loadBindingTables } from '@gc/findings';
import { localise } from '@gc/i18n';
import { loadCatalogue, loadGuides } from '@gc/remedies';

// The guide pages (S-15, R-03): one per finding type, public, rendered from the guide
// content in the reader's language, with the provisions the binding names for each
// supported jurisdiction and the remedy's snippet where there is one.

const guides = loadGuides();
const catalogue = loadCatalogue();
const tables = loadBindingTables();

export interface GuideSummary {
  readonly id: string;
  readonly findingTypeId: string;
  readonly area: string;
  readonly title: string;
}

export interface GuideView extends GuideSummary {
  readonly wrong: string;
  readonly why: string;
  readonly steps: readonly string[];
  readonly confirm: string;
  readonly keywords: readonly string[];
  readonly snippet?: string;
  readonly remedyTitle?: string;
  // The provisions per jurisdiction, as the binding tables give them.
  readonly law: readonly { jurisdiction: string; authority: string; citations: string[] }[];
}

const area = new Map(DETECTORS.map((d) => [d.findingTypeId, d.area]));

const citationText = (c: Citation): string => {
  if (c.kind === 'provision') return `${c.instrument} ${c.ref}`;
  if (c.kind === 'decision') return `${c.body} ${c.reference}`;
  return `${c.authority}: ${c.title}`;
};

export function listGuides(locale: Locale): GuideSummary[] {
  return guides.guides
    .map((g) => ({
      id: g.id,
      findingTypeId: g.findingTypeId,
      area: area.get(g.findingTypeId) ?? '',
      title: localise(g.title, locale).value,
    }))
    .sort((a, b) => a.area.localeCompare(b.area) || a.findingTypeId.localeCompare(b.findingTypeId));
}

export function guideView(id: string, locale: Locale): GuideView | undefined {
  const g = guides.byId(id);
  if (!g) return undefined;
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
    wrong: L(g.wrong),
    why: L(g.why),
    steps: g.steps.map((s) => L(s)),
    confirm: L(g.confirm),
    keywords: g.keywords.map((k) => L(k)),
    ...(snippet ? { snippet } : {}),
    ...(remedy ? { remedyTitle: L(remedy.title) } : {}),
    law,
  };
}

export const guideIds = (): string[] => guides.guides.map((g) => g.id);
