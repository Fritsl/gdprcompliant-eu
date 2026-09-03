import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { DEFAULT_LOCALE, LocaleSchema, type Locale } from '@gc/contracts';
import localesJson from '../content/locales.json' with { type: 'json' };

// The locales the product speaks are content: packages/i18n/content/locales.json.
// Adding one is a change to that file, and to the content files that carry its text —
// never to code. `required` means the coverage check fails while any string lacks it.
//
// The file is imported as a module rather than read from disk so that bundlers (the web
// app) and Node (workers, tests) see the same thing without path arithmetic.

export const LocaleInfoSchema = z.object({
  code: LocaleSchema,
  name: z.string().min(1).describe('The language, in itself: Dansk, Deutsch'),
  required: z.boolean(),
});
export type LocaleInfo = z.infer<typeof LocaleInfoSchema>;

export const LocalesFileSchema = z
  .object({
    default: LocaleSchema,
    locales: z.array(LocaleInfoSchema).min(1),
  })
  .superRefine((f, ctx) => {
    const codes = f.locales.map((l) => l.code);
    if (new Set(codes).size !== codes.length) {
      ctx.addIssue({ code: 'custom', path: ['locales'], message: 'a locale is listed twice' });
    }
    if (f.default !== DEFAULT_LOCALE) {
      ctx.addIssue({
        code: 'custom',
        path: ['default'],
        message: `the fallback locale is ${DEFAULT_LOCALE}; LocalisedText requires it`,
      });
    }
    const fallback = f.locales.find((l) => l.code === f.default);
    if (!fallback) {
      ctx.addIssue({
        code: 'custom',
        path: ['locales'],
        message: 'the default locale is not listed',
      });
    } else if (!fallback.required) {
      ctx.addIssue({
        code: 'custom',
        path: ['locales'],
        message: 'the default locale is required',
      });
    }
  });
export type LocalesFile = z.infer<typeof LocalesFileSchema>;

export function parseLocales(raw: unknown, source = 'locales.json'): LocalesFile {
  const parsed = LocalesFileSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`${source}: ${detail}`);
  }
  return parsed.data;
}

// Read a locales file from disk: tests use this with their own files.
export function readLocales(file: string | URL): LocalesFile {
  return parseLocales(JSON.parse(readFileSync(file, 'utf8')), String(file));
}

const file = parseLocales(localesJson, 'packages/i18n/content/locales.json');

export const LOCALES: readonly LocaleInfo[] = file.locales;
export const LOCALE_CODES: readonly Locale[] = file.locales.map((l) => l.code);
export const REQUIRED_LOCALES: readonly Locale[] = file.locales
  .filter((l) => l.required)
  .map((l) => l.code);

export function isKnownLocale(code: string): code is Locale {
  return LOCALE_CODES.includes(code);
}
