import 'server-only';
import {
  DEFAULT_LOCALE,
  LocalisedTextSchema,
  type Locale,
  type LocalisedText,
} from '@gc/contracts';
import { LOCALES, LOCALE_CODES, isKnownLocale, localise } from '@gc/i18n';
import raw from '@/content/messages.json';

// UI strings are content (I-01): apps/web/content/messages.json, one LocalisedText per
// key. Components never carry a literal; they ask for a key. A missing variant falls
// back to English and comes back flagged, so the markup can say so.

export type Messages = Record<string, LocalisedText>;

let cache: Messages | undefined;

export function messages(): Messages {
  if (cache) return cache;
  const out: Messages = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const parsed = LocalisedTextSchema.safeParse(value);
    if (!parsed.success) throw new Error(`messages.json: ${key} is not a LocalisedText`);
    out[key] = parsed.data;
  }
  cache = out;
  return out;
}

export interface Translation {
  readonly text: string;
  readonly lang: Locale;
  readonly fellBack: boolean;
}

export function t(locale: Locale, key: string): Translation {
  const entry = messages()[key];
  if (!entry) throw new Error(`messages.json has no key ${key}`);
  const picked = localise(entry, locale);
  return { text: picked.value, lang: picked.locale, fellBack: picked.fellBack };
}

export const locales = LOCALES;
export const localeCodes = LOCALE_CODES;
export const defaultLocale: Locale = DEFAULT_LOCALE;

export function asLocale(value: string): Locale | undefined {
  return isKnownLocale(value) ? value : undefined;
}
