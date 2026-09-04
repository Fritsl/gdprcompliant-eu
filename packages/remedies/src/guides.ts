import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GuideSchema, type Guide, type Locale } from '@gc/contracts';

// The guides (S-15, R-03): content/guides/<id>.json, one per finding type, validated on
// load. A guide whose file name disagrees with its id, or whose finding type has two
// guides, is refused: the id is what a binding and a page address it by.

export const GUIDES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../content/guides/');

export class GuideError extends Error {
  constructor(
    public readonly file: string,
    message: string,
  ) {
    super(`${basename(file)}: ${message}`);
    this.name = 'GuideError';
  }
}

export interface GuideLibrary {
  readonly guides: readonly Guide[];
  byId(id: string): Guide | undefined;
  forFinding(findingTypeId: string): Guide | undefined;
  // Locales every guide carries in full.
  completeLocales(): Locale[];
}

// The locales a guide is written in, in full: every field, every step, every keyword.
export function guideLocales(g: Guide): Locale[] {
  const locales: Locale[] = ['en', 'da', 'de'];
  const texts = [g.title, g.wrong, g.why, g.confirm, ...g.steps, ...g.keywords];
  return locales.filter((locale) =>
    texts.every((t) => typeof t[locale] === 'string' && t[locale]!.length > 0),
  );
}

export function loadGuides(dir = GUIDES_DIR): GuideLibrary {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  const guides: Guide[] = [];
  const byType = new Map<string, string>();
  for (const f of files) {
    const file = join(dir, f);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      throw new GuideError(file, `not valid JSON (${(e as Error).message})`);
    }
    const parsed = GuideSchema.safeParse(raw);
    if (!parsed.success) {
      throw new GuideError(
        file,
        parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
      );
    }
    const guide = parsed.data;
    if (guide.id !== basename(f, '.json'))
      throw new GuideError(file, `id ${guide.id} does not match the file name`);
    const other = byType.get(guide.findingTypeId);
    if (other) throw new GuideError(file, `${guide.findingTypeId} already has guide ${other}`);
    byType.set(guide.findingTypeId, guide.id);
    guides.push(guide);
  }
  const ids = new Map(guides.map((g) => [g.id, g]));
  const types = new Map(guides.map((g) => [g.findingTypeId, g]));
  return {
    guides,
    byId: (id) => ids.get(id),
    forFinding: (typeId) => types.get(typeId),
    completeLocales: () => {
      const locales: Locale[] = ['en', 'da', 'de'];
      return locales.filter((locale) => guides.every((g) => guideLocales(g).includes(locale)));
    },
  };
}
