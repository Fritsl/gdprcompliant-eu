import {
  RenderedRemedySchema,
  type Locale,
  type LocalisedText,
  type Remedy,
  type RenderedRemedy,
} from '@gc/contracts';
import { localise } from '@gc/i18n';

// One locale out of a catalogue entry. A missing variant falls back to English and is
// named in `missing`, so the caller can show it and the i18n coverage check (I-01) can
// count it. Nothing falls back silently.

// The paths in a remedy that hold translatable text. Everything else is data or code.
const TEXT_PATHS = [
  'title',
  'detail',
  'verifyLabel',
  'cta',
  'alternativeNote',
  'askLabel',
  'effort.label',
  'action.label',
  'action.body',
  'action.forwardable',
  'action.to',
  'action.subject',
  'options[].note',
] as const;

export interface Localised {
  rendered: RenderedRemedy;
  // Paths that fell back to English, e.g. "detail", "options[1].note".
  missing: string[];
}

function pick(text: LocalisedText, locale: Locale, path: string, missing: string[]): string {
  const picked = localise(text, locale);
  if (picked.fellBack) missing.push(path);
  return picked.value;
}

function localiseAt(
  node: Record<string, unknown>,
  segments: string[],
  locale: Locale,
  path: string,
  missing: string[],
): void {
  const [head, ...rest] = segments;
  if (head === undefined) return;
  const isList = head.endsWith('[]');
  const key = isList ? head.slice(0, -2) : head;
  const value = node[key];
  if (value === undefined) return;

  if (isList) {
    if (!Array.isArray(value)) return;
    value.forEach((item, i) => {
      if (item !== null && typeof item === 'object') {
        localiseAt(item as Record<string, unknown>, rest, locale, `${path}${key}[${i}].`, missing);
      }
    });
    return;
  }

  if (rest.length === 0) {
    node[key] = pick(value as LocalisedText, locale, `${path}${key}`, missing);
    return;
  }
  if (value !== null && typeof value === 'object') {
    localiseAt(value as Record<string, unknown>, rest, locale, `${path}${key}.`, missing);
  }
}

export function renderRemedy(remedy: Remedy, locale: Locale): Localised {
  const copy = structuredClone(remedy) as unknown as Record<string, unknown>;
  const missing: string[] = [];
  for (const textPath of TEXT_PATHS) localiseAt(copy, textPath.split('.'), locale, '', missing);
  copy['locale'] = locale;
  // The rendered shape is the same definition as the catalogue shape, so this cannot
  // fail unless TEXT_PATHS has drifted from the schema — and then it should be loud.
  const rendered = RenderedRemedySchema.parse(copy);
  return { rendered, missing };
}
