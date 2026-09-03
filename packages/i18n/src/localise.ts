import { DEFAULT_LOCALE, type Locale, type LocalisedText } from '@gc/contracts';

// One string out of a LocalisedText. A missing variant falls back to English, and the
// caller is told so it can show it: an English sentence on a Danish page is a defect
// the reader should be able to see and we should be able to count, never a silent swap.

export interface Localised {
  readonly value: string;
  readonly locale: Locale;
  readonly fellBack: boolean;
}

export function localise(text: LocalisedText, locale: Locale): Localised {
  const variant = text[locale];
  if (typeof variant === 'string') return { value: variant, locale, fellBack: false };
  const fallback = text[DEFAULT_LOCALE];
  if (typeof fallback !== 'string') {
    throw new Error(
      `localised text has no ${DEFAULT_LOCALE} variant; the schema should have refused it`,
    );
  }
  return { value: fallback, locale: DEFAULT_LOCALE, fellBack: true };
}

// Shape test shared with scripts/i18n-coverage.mjs: an object whose keys are all locale
// codes, whose values are all strings, and which carries the fallback locale.
const LOCALE_KEY = /^[a-z]{2}(-[A-Z]{2})?$/;

export function isLocalisedText(value: unknown): value is LocalisedText {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return (
    typeof record[DEFAULT_LOCALE] === 'string' &&
    keys.every((k) => LOCALE_KEY.test(k)) &&
    keys.every((k) => typeof record[k] === 'string')
  );
}

export interface LocalisedDeep<T> {
  readonly value: T;
  // Paths that fell back to English, e.g. "title", "options[1].note".
  readonly missing: readonly string[];
}

// Replace every LocalisedText inside a content object with one locale's string.
export function localiseDeep<T>(node: unknown, locale: Locale): LocalisedDeep<T> {
  const missing: string[] = [];
  const walk = (value: unknown, path: string): unknown => {
    if (isLocalisedText(value)) {
      const picked = localise(value, locale);
      if (picked.fellBack) missing.push(path);
      return picked.value;
    }
    if (Array.isArray(value)) return value.map((v, i) => walk(v, `${path}[${i}]`));
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = walk(v, path === '' ? k : `${path}.${k}`);
      }
      return out;
    }
    return value;
  };
  return { value: walk(node, '') as T, missing };
}
