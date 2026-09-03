import {
  RenderedRemedySchema,
  type Jurisdiction,
  type Locale,
  type RemedyKind,
  type RemedyRef,
  type RenderedRemedy,
} from '@gc/contracts';
import { type Catalogue, type CatalogueEntry } from './catalogue.js';
import { renderRemedy } from './localise.js';
import { fill, type PlaceholderValues } from './placeholders.js';

// Given a finding and what we know about the case, pick the cheapest remedy that
// genuinely closes it, honestly. The rules are few and they are tests:
//
//   a free self-service fix outranks a paid one whenever both close the finding;
//   among paid remedies, someone else's comes before ours, and ours is flagged as ours;
//   a partner alternative with fewer than two options is not a choice, so it is refused;
//   a template we cannot fill completely from the facts is not finished, so it is refused;
//   when nothing closes the finding, the answer is the no_solution fallback, and it says why.
//
// Resolution is deterministic: same catalogue, same finding, same context, same answer,
// with the reason and every rejected candidate on the result.

export const FALLBACK_REMEDY_ID = 'any-00-no-solution';
export const MIN_PARTNER_OPTIONS = 2;

export type RemedyCost = 'free' | 'paid' | 'none';

export function costOf(kind: RemedyKind): RemedyCost {
  switch (kind) {
    case 'self_fix':
    case 'generated_artefact':
      return 'free';
    case 'our_product':
    case 'partner_alternative':
      return 'paid';
    case 'no_solution':
      return 'none';
  }
}

export const isOurs = (kind: RemedyKind): boolean => kind === 'our_product';

// Lower ranks first. Free, then paid-but-not-ours, then ours, then no_solution.
function tierOf(kind: RemedyKind): number {
  const cost = costOf(kind);
  if (cost === 'free') return 0;
  if (cost === 'paid') return isOurs(kind) ? 2 : 1;
  return 3;
}

export interface ResolveContext {
  readonly jurisdiction: Jurisdiction;
  readonly locale: Locale;
  // The facts that fill the templates: the domain, the hosts, the paths. From evidence,
  // never from a model.
  readonly values: PlaceholderValues;
}

export interface Candidate {
  readonly id: string;
  readonly kind: RemedyKind;
  readonly cost: RemedyCost;
  readonly ours: boolean;
  readonly specific: boolean;
  readonly rejected?: string;
}

export interface Resolution {
  readonly findingTypeId: string;
  readonly jurisdiction: Jurisdiction;
  readonly locale: Locale;
  readonly ref: RemedyRef;
  readonly remedy: RenderedRemedy;
  readonly cost: RemedyCost;
  readonly ours: boolean;
  readonly closes: boolean;
  readonly fallback: boolean;
  readonly reason: string;
  readonly candidates: readonly Candidate[];
  readonly missingTranslations: readonly string[];
}

export class ResolverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResolverError';
  }
}

function fillRemedy(
  rendered: RenderedRemedy,
  values: PlaceholderValues,
): { remedy: RenderedRemedy; unfilled: string[] } {
  const unfilled = new Set<string>();
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      const r = fill(node, values);
      for (const u of r.unfilled) unfilled.add(u);
      return r.text;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === 'object') {
      return Object.fromEntries(
        Object.entries(node as Record<string, unknown>).map(([k, v]) => [k, walk(v)]),
      );
    }
    return node;
  };
  const remedy = RenderedRemedySchema.parse(walk(rendered));
  return { remedy, unfilled: [...unfilled].sort() };
}

function describe(entry: CatalogueEntry, jurisdiction: Jurisdiction): Omit<Candidate, 'rejected'> {
  const { id, kind, jurisdictions } = entry.remedy;
  return {
    id,
    kind,
    cost: costOf(kind),
    ours: isOurs(kind),
    specific: jurisdictions !== 'all' && jurisdictions.includes(jurisdiction),
  };
}

export function resolveRemedy(
  catalogue: Catalogue,
  findingTypeId: string,
  context: ResolveContext,
): Resolution {
  const { jurisdiction, locale, values } = context;
  const fallbackEntry = catalogue.get(FALLBACK_REMEDY_ID);
  if (!fallbackEntry || fallbackEntry.remedy.kind !== 'no_solution') {
    throw new ResolverError(`the catalogue has no ${FALLBACK_REMEDY_ID} entry of kind no_solution`);
  }

  const ordered = [...catalogue.forFinding(findingTypeId, jurisdiction)].sort((a, b) => {
    const tier = tierOf(a.remedy.kind) - tierOf(b.remedy.kind);
    if (tier !== 0) return tier;
    const specific =
      Number(describe(b, jurisdiction).specific) - Number(describe(a, jurisdiction).specific);
    if (specific !== 0) return specific;
    return a.remedy.id.localeCompare(b.remedy.id);
  });

  const candidates: Candidate[] = [];
  let chosen:
    | { entry: CatalogueEntry; remedy: RenderedRemedy; missing: string[]; reason: string }
    | undefined;

  for (const entry of ordered) {
    const base = describe(entry, jurisdiction);
    if (chosen) {
      const chosenKind = chosen.entry.remedy.kind;
      candidates.push({
        ...base,
        rejected:
          costOf(chosenKind) === 'free' && base.cost === 'paid'
            ? `a paid remedy while ${chosen.entry.remedy.id} closes ${findingTypeId} for free`
            : `outranked by ${chosen.entry.remedy.id}`,
      });
      continue;
    }
    const kind = entry.remedy.kind;
    if (kind === 'no_solution') {
      candidates.push({
        ...base,
        rejected: 'a no_solution does not close the finding; kept as the fallback',
      });
      continue;
    }
    if (
      entry.remedy.kind === 'partner_alternative' &&
      entry.remedy.options.length < MIN_PARTNER_OPTIONS
    ) {
      candidates.push({
        ...base,
        rejected: `${entry.remedy.options.length} option(s) — fewer than ${MIN_PARTNER_OPTIONS} is not a choice`,
      });
      continue;
    }
    const localised = renderRemedy(entry.remedy, locale);
    const filled = fillRemedy(localised.rendered, values);
    if (filled.unfilled.length > 0) {
      candidates.push({
        ...base,
        rejected: `needs ${filled.unfilled.map((u) => `{{${u}}}`).join(', ')}, which the case does not supply`,
      });
      continue;
    }
    const paidRejected = candidates.filter((c) => c.rejected !== undefined).length;
    const reason =
      base.cost === 'free'
        ? `${base.id}: a free ${kind.replace('_', ' ')} that closes ${findingTypeId}` +
          (paidRejected > 0 ? `, chosen over ${paidRejected} candidate(s) rejected first` : '')
        : base.ours
          ? `${base.id}: ours, and no free fix or partner alternative closes ${findingTypeId}; flagged as ours`
          : `${base.id}: a paid partner alternative; no free fix closes ${findingTypeId}`;
    chosen = { entry, remedy: filled.remedy, missing: localised.missing, reason };
    candidates.push(base);
  }

  if (chosen) {
    return {
      findingTypeId,
      jurisdiction,
      locale,
      ref: { remedyId: chosen.entry.remedy.id, version: chosen.entry.remedy.version },
      remedy: chosen.remedy,
      cost: costOf(chosen.entry.remedy.kind),
      ours: isOurs(chosen.entry.remedy.kind),
      closes: true,
      fallback: false,
      reason: chosen.reason,
      candidates,
      missingTranslations: chosen.missing,
    };
  }

  const fallback = renderRemedy(fallbackEntry.remedy, locale);
  const filledFallback = fillRemedy(fallback.rendered, values);
  const why =
    candidates.length === 0
      ? `no remedy in the catalogue for ${findingTypeId} in ${jurisdiction}`
      : `every candidate was refused: ${candidates.map((c) => `${c.id} (${c.rejected})`).join('; ')}`;
  return {
    findingTypeId,
    jurisdiction,
    locale,
    ref: { remedyId: fallbackEntry.remedy.id, version: fallbackEntry.remedy.version },
    remedy: filledFallback.remedy,
    cost: 'none',
    ours: false,
    closes: false,
    fallback: true,
    reason: `${FALLBACK_REMEDY_ID}: ${why}`,
    candidates,
    missingTranslations: fallback.missing,
  };
}
