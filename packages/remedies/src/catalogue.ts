import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RemedySchema, type Jurisdiction, type Remedy } from '@gc/contracts';
import { canonicalJson, sha256 } from './canonical.js';
import { PLACEHOLDERS, placeholdersIn } from './placeholders.js';

// The remedy catalogue is content: one JSON file per remedy under content/remedies, each
// a Remedy in catalogue form (locale variants, template placeholders). Loading validates
// every file against the schema and against the rules a schema cannot express, and fails
// loudly on the first problem. There is no partial catalogue.

export const CONTENT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../content/remedies/');
export const LOCK_FILE_NAME = 'catalogue.lock.json';

export class CatalogueError extends Error {
  constructor(
    public readonly file: string,
    message: string,
  ) {
    super(`${file}: ${message}`);
    this.name = 'CatalogueError';
  }
}

export interface CatalogueEntry {
  readonly remedy: Remedy;
  readonly file: string;
  // Hash of everything except the version, so a content change is detectable.
  readonly hash: string;
}

export function entryHash(remedy: Remedy): string {
  const content: Record<string, unknown> = { ...remedy };
  delete content['version'];
  return sha256(canonicalJson(content));
}

export function validateEntry(raw: unknown, file: string): Remedy {
  const parsed = RemedySchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new CatalogueError(file, detail);
  }
  const remedy = parsed.data;

  // The schema strips keys it does not know. Content must not carry any: a misspelt key
  // would otherwise vanish silently.
  if (canonicalJson(remedy) !== canonicalJson(raw)) {
    throw new CatalogueError(file, 'contains keys the remedy schema does not know');
  }

  // Verification must be able to close what the remedy promises.
  if (remedy.kind === 'generated_artefact') {
    if (
      remedy.verification.method !== 'artefact_published' ||
      remedy.verification.artefact !== remedy.artefact
    ) {
      throw new CatalogueError(
        file,
        `a generated_artefact is verified by publishing ${remedy.artefact}`,
      );
    }
  }
  if (remedy.kind === 'no_solution' && remedy.verification.method !== 'none') {
    throw new CatalogueError(
      file,
      'a no_solution has nothing to verify; declare method none with a reason',
    );
  }
  if (remedy.kind !== 'no_solution' && remedy.verification.method === 'none') {
    throw new CatalogueError(file, 'only a no_solution may declare no verification');
  }

  for (const p of placeholdersIn(remedy)) {
    if (!PLACEHOLDERS.has(p)) throw new CatalogueError(file, `unknown placeholder {{${p}}}`);
  }

  return remedy;
}

export class Catalogue {
  private readonly byId = new Map<string, CatalogueEntry>();
  private readonly byType = new Map<string, CatalogueEntry[]>();

  constructor(entries: Iterable<CatalogueEntry>) {
    for (const entry of entries) {
      const { id, findingTypeId } = entry.remedy;
      const existing = this.byId.get(id);
      if (existing)
        throw new CatalogueError(
          entry.file,
          `duplicate remedy id ${id} (also in ${existing.file})`,
        );
      this.byId.set(id, entry);
      const list = this.byType.get(findingTypeId) ?? [];
      list.push(entry);
      this.byType.set(findingTypeId, list);
    }
  }

  all(): CatalogueEntry[] {
    return [...this.byId.values()];
  }

  ids(): string[] {
    return [...this.byId.keys()].sort();
  }

  // The current entry for an id. With a version, only if the catalogue still holds that
  // version: a finding pinned to an older version gets undefined, never a silent upgrade.
  // Every entry, newest version of each id first.
  get entries(): CatalogueEntry[] {
    return [...this.byId.values()].flat();
  }

  get(id: string, version?: number): CatalogueEntry | undefined {
    const entry = this.byId.get(id);
    if (!entry) return undefined;
    if (version !== undefined && entry.remedy.version !== version) return undefined;
    return entry;
  }

  // Remedies for a finding type in a jurisdiction. Jurisdiction-specific entries come
  // before entries scoped to all. An unsupported jurisdiction yields an empty list, never
  // a fallback to another country's law.
  forFinding(findingTypeId: string, jurisdiction: Jurisdiction): CatalogueEntry[] {
    const candidates = this.byType.get(findingTypeId) ?? [];
    const specific = candidates.filter(
      (e) => e.remedy.jurisdictions !== 'all' && e.remedy.jurisdictions.includes(jurisdiction),
    );
    const general = candidates.filter((e) => e.remedy.jurisdictions === 'all');
    const byId = (a: CatalogueEntry, b: CatalogueEntry) => a.remedy.id.localeCompare(b.remedy.id);
    return [...specific.sort(byId), ...general.sort(byId)];
  }

  findingTypeIds(): string[] {
    return [...this.byType.keys()].sort();
  }
}

export function loadCatalogue(dir: string = CONTENT_DIR): Catalogue {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json') && f !== LOCK_FILE_NAME)
    .sort();
  const entries = files.map((file): CatalogueEntry => {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    } catch (e) {
      throw new CatalogueError(file, `not valid JSON (${(e as Error).message})`);
    }
    const remedy = validateEntry(raw, file);
    if (basename(file, '.json') !== remedy.id) {
      throw new CatalogueError(file, `file name does not match id ${remedy.id}`);
    }
    return { remedy, file, hash: entryHash(remedy) };
  });
  return new Catalogue(entries);
}
