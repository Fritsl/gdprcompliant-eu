import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCALE, LocalisedTextSchema } from '@gc/contracts';
import {
  LOCALES,
  LOCALE_CODES,
  LocalesFileSchema,
  REQUIRED_LOCALES,
  isKnownLocale,
  isLocalisedText,
  localise,
  localiseDeep,
  readLocales,
} from '@gc/i18n';
import {
  ROOT,
  contentFiles,
  coverage,
  failures,
  findLocalisedText,
  report,
} from '../../../scripts/i18n-coverage.mjs';

describe('locales are content (I-01)', () => {
  it('the locale list comes from locales.json and is valid', () => {
    expect(LOCALES.length).toBeGreaterThanOrEqual(2);
    expect(LOCALE_CODES).toContain('en');
    expect(LOCALE_CODES).toContain('da');
    expect(REQUIRED_LOCALES).toContain(DEFAULT_LOCALE);
    expect(isKnownLocale('da')).toBe(true);
    expect(isKnownLocale('xx')).toBe(false);
  });

  it('the file cannot drop, duplicate or un-require the fallback locale', () => {
    const base = { default: 'en', locales: [{ code: 'en', name: 'English', required: true }] };
    expect(LocalesFileSchema.safeParse(base).success).toBe(true);
    expect(LocalesFileSchema.safeParse({ ...base, default: 'da' }).success).toBe(false);
    expect(
      LocalesFileSchema.safeParse({
        ...base,
        locales: [{ code: 'en', name: 'English', required: false }],
      }).success,
    ).toBe(false);
    expect(
      LocalesFileSchema.safeParse({
        ...base,
        locales: [...base.locales, { code: 'en', name: 'Again', required: true }],
      }).success,
    ).toBe(false);
  });

  it('adding a locale is a content change: a new code appears in coverage with no code touched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'i18n-'));
    writeFileSync(
      join(dir, 'locales.json'),
      JSON.stringify({
        default: 'en',
        locales: [
          { code: 'en', name: 'English', required: true },
          { code: 'sv', name: 'Svenska', required: false },
        ],
      }),
    );
    const locales = readLocales(pathToFileURL(join(dir, 'locales.json')));
    expect(locales.locales.map((l) => l.code)).toEqual(['en', 'sv']);

    const cov = coverage({ locales });
    const sv = cov.locales.find((l) => l.code === 'sv');
    expect(sv?.translated).toBe(0);
    expect(sv?.missing.length).toBe(cov.strings);
  });
});

describe('fallback is visible and reported', () => {
  const text = { en: 'Move the tags', da: 'Flyt dine tags' };

  it('returns the variant when it exists', () => {
    expect(localise(text, 'da')).toEqual({
      value: 'Flyt dine tags',
      locale: 'da',
      fellBack: false,
    });
  });

  it('falls back to English and says so', () => {
    expect(localise(text, 'de')).toEqual({ value: 'Move the tags', locale: 'en', fellBack: true });
  });

  it('never invents text: a record without English is refused by the schema, and by localise', () => {
    expect(LocalisedTextSchema.safeParse({ da: 'kun dansk' }).success).toBe(false);
    expect(() => localise({ da: 'kun dansk' } as never, 'de')).toThrow(/no en variant/);
  });

  it('localiseDeep replaces every translatable string and names each fallback by path', () => {
    const content = {
      title: { en: 'Title', da: 'Titel' },
      effort: { label: { en: 'About 20 minutes' }, minutes: 20 },
      options: [
        { name: 'A', note: { en: 'note a', da: 'note a (da)' } },
        { name: 'B', note: { en: 'note b' } },
      ],
      product: { id: 'gdprchat', url: 'https://gdprchat.eu' },
    };
    const { value, missing } = localiseDeep<Record<string, unknown>>(content, 'da');
    expect(value['title']).toBe('Titel');
    expect((value['effort'] as { label: string }).label).toBe('About 20 minutes');
    expect((value['options'] as { note: string }[])[1]?.note).toBe('note b');
    expect(value['product']).toEqual({ id: 'gdprchat', url: 'https://gdprchat.eu' });
    expect(missing).toEqual(['effort.label', 'options[1].note']);
  });

  it('recognises translatable strings by shape, in both implementations', () => {
    const yes = [{ en: 'x' }, { en: 'x', da: 'y', 'pt-BR': 'z' }];
    const no = [
      { da: 'x' },
      { en: 'x', minutes: 20 },
      { id: 'x', url: 'y' },
      'x',
      null,
      [{ en: 'x' }],
      { en: 1 },
    ];
    for (const v of yes) expect(isLocalisedText(v), JSON.stringify(v)).toBe(true);
    for (const v of no) expect(isLocalisedText(v), JSON.stringify(v)).toBe(false);
    expect(
      findLocalisedText({ a: { en: 'x' }, b: [{ c: { en: 'y' } }], d: { id: 'x', url: 'y' } }),
    ).toEqual([
      { path: 'a', text: { en: 'x' } },
      { path: 'b[0].c', text: { en: 'y' } },
    ]);
  });
});

describe('the coverage check lists untranslated content per locale', () => {
  const cov = coverage();

  it('walks every content file and finds strings', () => {
    expect(contentFiles().length).toBeGreaterThan(0);
    expect(contentFiles().every((f) => f.endsWith('.json') && !f.endsWith('.lock.json'))).toBe(
      true,
    );
    expect(cov.files).toBe(contentFiles().length);
    expect(cov.strings).toBeGreaterThan(20);
  });

  it('English is always complete, and every string is a valid LocalisedText', () => {
    const en = cov.locales.find((l) => l.code === 'en');
    expect(en?.missing).toEqual([]);
    for (const file of contentFiles()) {
      for (const { text } of findLocalisedText(JSON.parse(readFileSync(file, 'utf8')))) {
        expect(LocalisedTextSchema.safeParse(text).success).toBe(true);
      }
    }
  });

  it('lists what Danish still lacks, file by file', () => {
    const da = cov.locales.find((l) => l.code === 'da');
    expect(da).toBeDefined();
    expect(da!.translated).toBeGreaterThan(0);
    expect(da!.missing.length).toBeGreaterThan(0);
    expect(da!.missing[0]).toEqual({
      file: expect.stringMatching(/^packages\/.*\.json$/),
      path: expect.any(String),
    });
    const text = report(cov);
    expect(text).toMatch(/^i18n coverage — \d+ content files, \d+ translatable strings/);
    expect(text).toMatch(/\n {2}da {4}\s*\d+\/\d+\s+\d+%\s+optional/);
    expect(text).toContain('packages/remedies/content/remedies/');
  });

  it('a required locale with gaps fails; the committed content passes', () => {
    expect(failures(cov)).toEqual([]);
    const strict = coverage({
      locales: {
        default: 'en',
        locales: [
          { code: 'en', name: 'English', required: true },
          { code: 'da', name: 'Dansk', required: true },
        ],
      },
    });
    expect(failures(strict).map((l) => l.code)).toEqual(['da']);
    expect(report(strict)).toMatch(/da .*required, FAIL/);
  });

  it('runs as the CI command and exits 0 on the committed content', () => {
    const out = execFileSync('node', [join(ROOT, 'scripts', 'i18n-coverage.mjs')], {
      encoding: 'utf8',
    });
    expect(out).toMatch(/^i18n coverage/);
    expect(out).toMatch(/en .*required, complete/);
  });

  it('a package with no content directory is simply absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'i18n-root-'));
    mkdirSync(join(root, 'packages', 'empty', 'src'), { recursive: true });
    expect(contentFiles(root)).toEqual([]);
    expect(coverage({ root, locales: readLocales() }).strings).toBe(0);
  });
});
