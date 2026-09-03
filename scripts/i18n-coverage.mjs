#!/usr/bin/env node
// List the untranslated content per locale (I-01).
//
//   node scripts/i18n-coverage.mjs            report; exit 1 if a required locale has gaps
//   node scripts/i18n-coverage.mjs --json     the same, as JSON
//
// Content is every packages/*/content/**/*.json. A translatable string is an object whose
// keys are all locale codes, whose values are all strings, and which has an `en` variant
// (the same shape test as packages/i18n/src/localise.ts). The locales, and which of them
// are required, come from packages/i18n/content/locales.json — adding a locale is a
// change to that file, never to this one.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const LOCALES_FILE = join(ROOT, 'packages', 'i18n', 'content', 'locales.json');
const LOCALE_KEY = /^[a-z]{2}(-[A-Z]{2})?$/;
const DEFAULT_LOCALE = 'en';

export function isLocalisedText(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return (
    typeof value[DEFAULT_LOCALE] === 'string' &&
    keys.every((k) => LOCALE_KEY.test(k)) &&
    keys.every((k) => typeof value[k] === 'string')
  );
}

export function findLocalisedText(value, path = '', out = []) {
  if (isLocalisedText(value)) {
    out.push({ path, text: value });
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => findLocalisedText(v, `${path}[${i}]`, out));
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      findLocalisedText(v, path === '' ? k : `${path}.${k}`, out);
    }
  }
  return out;
}

function walk(dir, out = []) {
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.json') && !entry.endsWith('.lock.json') && entry !== 'locales.json') {
      out.push(full);
    }
  }
  return out;
}

export function contentFiles(root = ROOT) {
  const packages = join(root, 'packages');
  let dirs = [];
  try {
    dirs = readdirSync(packages);
  } catch {
    return [];
  }
  return dirs
    .map((d) => join(packages, d, 'content'))
    .flatMap((d) => walk(d))
    .sort();
}

export function readLocales(file = LOCALES_FILE) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

// { files, strings, locales: [{ code, name, required, translated, total, missing: [{ file, path }] }] }
export function coverage({ root = ROOT, locales = readLocales() } = {}) {
  const files = contentFiles(root);
  const strings = [];
  for (const file of files) {
    const rel = relative(root, file).split(sep).join('/');
    for (const { path, text } of findLocalisedText(JSON.parse(readFileSync(file, 'utf8')))) {
      strings.push({ file: rel, path, text });
    }
  }
  return {
    files: files.length,
    strings: strings.length,
    locales: locales.locales.map((l) => {
      const missing = strings
        .filter((s) => typeof s.text[l.code] !== 'string')
        .map(({ file, path }) => ({ file, path }));
      return {
        code: l.code,
        name: l.name,
        required: l.required,
        translated: strings.length - missing.length,
        total: strings.length,
        missing,
      };
    }),
  };
}

export function failures(cov) {
  return cov.locales.filter((l) => l.required && l.missing.length > 0);
}

export function report(cov) {
  const lines = [`i18n coverage — ${cov.files} content files, ${cov.strings} translatable strings`];
  for (const l of cov.locales) {
    const pct = cov.strings === 0 ? 100 : Math.floor((100 * l.translated) / cov.strings);
    const state = l.required ? (l.missing.length === 0 ? 'required, complete' : 'required, FAIL') : 'optional';
    lines.push(`  ${l.code.padEnd(5)} ${String(l.translated).padStart(4)}/${l.total}  ${String(pct).padStart(3)}%  ${state}`);
    if (l.missing.length > 0) {
      const byFile = new Map();
      for (const m of l.missing) byFile.set(m.file, [...(byFile.get(m.file) ?? []), m.path]);
      for (const [file, paths] of byFile) lines.push(`        ${file}: ${paths.join(', ')}`);
    }
  }
  return lines.join('\n');
}

export function main(argv = process.argv.slice(2)) {
  const cov = coverage();
  const failed = failures(cov);
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ ...cov, ok: failed.length === 0 }, null, 2));
  } else {
    console.log(report(cov));
    if (failed.length > 0) {
      console.error(`\nrequired locale${failed.length > 1 ? 's' : ''} incomplete: ${failed.map((l) => l.code).join(', ')}`);
    }
  }
  return failed.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
