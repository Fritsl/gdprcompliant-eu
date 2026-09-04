import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalisedTextSchema, type Locale, type LocalisedText } from '@gc/contracts';
import { localise } from '@gc/i18n';

// The one disclaimer every document that leaves the product carries (O-03): the timeline
// PDF, the evidence pack, the JSON export, a signed artefact's download. It says what the
// document is not, in the reader's language, and it is content, so the claim check reads
// it like everything else.

export const DISCLAIMER_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'content',
  'disclaimer.json',
);

export const DISCLAIMER: LocalisedText = LocalisedTextSchema.parse(
  JSON.parse(readFileSync(DISCLAIMER_FILE, 'utf8')),
);

export function disclaimerText(locale: Locale | string): string {
  return localise(DISCLAIMER, locale as Locale).value;
}
