// @gc/i18n — the locales are content, the fallback is visible, the gaps are counted.
//
//   locales    LOCALES from content/locales.json; which are required
//   localise   one locale out of a LocalisedText, with the fallback reported
//
// The coverage check is scripts/i18n-coverage.mjs (pnpm run check:i18n-coverage).

export const PACKAGE = '@gc/i18n';

export * from './locales.js';
export * from './localise.js';
