import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REMEDY_KINDS, SUPPORTED_JURISDICTIONS, type Remedy } from '@gc/contracts';
import { LOCALE_CODES } from '@gc/i18n';
import {
  Catalogue,
  CatalogueError,
  LOCK_FILE,
  PLACEHOLDERS,
  buildLock,
  canonicalJson,
  entryHash,
  loadCatalogue,
  placeholdersIn,
  readLock,
  renderRemedy,
  validateEntry,
  verifyLock,
} from '@gc/remedies';

const catalogue = loadCatalogue();
const fixture = JSON.parse(
  readFileSync(new URL('../../../fixtures/companies/eksempelbutik.json', import.meta.url), 'utf8'),
) as { findings: { id: string }[]; newInWatch: { id: string } };
const fixtureFindingTypes = [...fixture.findings, fixture.newInWatch].map((f) => f.id);

const sample = (): Remedy => structuredClone(catalogue.get('cns-02-gate-tags')!.remedy);

describe('remedy catalogue content', () => {
  it('loads, and every entry is a valid remedy', () => {
    expect(catalogue.all().length).toBeGreaterThanOrEqual(13);
    for (const entry of catalogue.all()) {
      expect(entry.remedy.id).toBe(entry.file.replace(/\.json$/, ''));
      expect(entry.remedy.version).toBeGreaterThanOrEqual(1);
    }
  });

  it('kinds are exactly the five, and the seed uses all of them', () => {
    expect([...REMEDY_KINDS].sort()).toEqual(
      [
        'self_fix',
        'generated_artefact',
        'our_product',
        'partner_alternative',
        'no_solution',
      ].sort(),
    );
    const used = new Set(catalogue.all().map((e) => e.remedy.kind));
    expect([...used].sort()).toEqual([...REMEDY_KINDS].sort());
    expect(() => validateEntry({ ...sample(), kind: 'consultant' }, 'x.json')).toThrow(
      CatalogueError,
    );
  });

  it('every fixture finding type has a remedy in every supported jurisdiction', () => {
    for (const typeId of fixtureFindingTypes) {
      for (const jurisdiction of SUPPORTED_JURISDICTIONS) {
        expect(
          catalogue.forFinding(typeId, jurisdiction).length,
          `${typeId} in ${jurisdiction}`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it('every entry declares a verification method', () => {
    for (const entry of catalogue.all()) {
      expect(entry.remedy.verification.method).toBeDefined();
    }
  });

  it('only uses placeholders from the closed vocabulary', () => {
    for (const entry of catalogue.all()) {
      for (const p of placeholdersIn(entry.remedy))
        expect(PLACEHOLDERS.has(p), `{{${p}}} in ${entry.file}`).toBe(true);
    }
  });
});

describe('jurisdiction scope', () => {
  it('a jurisdiction-specific entry comes before the general one', () => {
    const dk = catalogue.forFinding('POL-09', 'DK').map((e) => e.remedy.id);
    expect(dk).toEqual(['pol-09-complaint-and-withdrawal-dk', 'pol-09-complaint-and-withdrawal']);
  });

  it('an unsupported jurisdiction gets the general entry only, never another country’s', () => {
    const fr = catalogue.forFinding('POL-09', 'FR').map((e) => e.remedy.id);
    expect(fr).toEqual(['pol-09-complaint-and-withdrawal']);
  });

  it('an unknown finding type degrades to an empty list, explicitly', () => {
    expect(catalogue.forFinding('XYZ-99', 'DK')).toEqual([]);
  });
});

describe('locale scope', () => {
  it('renders the requested locale and names every fallback', () => {
    const { rendered, missing } = renderRemedy(sample(), 'da');
    expect(rendered.locale).toBe('da');
    expect(rendered.title).toBe('Flyt dine tags om bag samtykket');
    expect(rendered.effort.label).toBe('Cirka 20 minutter');
    expect(rendered.detail).toMatch(/^Your tags fire/);
    expect(missing).toEqual(
      expect.arrayContaining([
        'detail',
        'verifyLabel',
        'action.label',
        'action.body',
        'action.forwardable',
      ]),
    );
    expect(missing).not.toContain('title');
  });

  it('English never falls back', () => {
    for (const entry of catalogue.all()) {
      expect(renderRemedy(entry.remedy, 'en').missing, entry.file).toEqual([]);
    }
  });

  it('every entry renders in every supported locale as a valid rendered remedy', () => {
    for (const entry of catalogue.all()) {
      for (const locale of LOCALE_CODES) {
        const { rendered } = renderRemedy(entry.remedy, locale);
        expect(rendered.kind).toBe(entry.remedy.kind);
        expect(rendered.locale).toBe(locale);
      }
    }
  });

  it('a fully translated entry has nothing missing', () => {
    const dk = catalogue.get('pol-09-complaint-and-withdrawal-dk')!.remedy;
    expect(renderRemedy(dk, 'da').missing).toEqual([]);
  });
});

describe('validation beyond the schema', () => {
  it('rejects keys the schema does not know, instead of dropping them', () => {
    expect(() => validateEntry({ ...sample(), verifyLabl: { en: 'typo' } }, 'x.json')).toThrow(
      /does not know/,
    );
  });

  it('a generated_artefact is verified by publishing that artefact', () => {
    const dpa = structuredClone(catalogue.get('dpa-01-processing-agreement')!.remedy);
    expect(() => validateEntry({ ...dpa, verification: { method: 'rescan' } }, 'x.json')).toThrow(
      /publishing/,
    );
    expect(() =>
      validateEntry(
        { ...dpa, verification: { method: 'artefact_published', artefact: 'privacy_policy' } },
        'x.json',
      ),
    ).toThrow(/publishing processing_agreement/);
  });

  it('only a no_solution may declare no verification, and it must', () => {
    expect(() =>
      validateEntry({ ...sample(), verification: { method: 'none', reason: 'because' } }, 'x.json'),
    ).toThrow(/only a no_solution/);
    const none = structuredClone(catalogue.get('vnd-11-unidentified-host')!.remedy);
    expect(() => validateEntry({ ...none, verification: { method: 'rescan' } }, 'x.json')).toThrow(
      /nothing to verify/,
    );
  });

  it('rejects a placeholder outside the vocabulary', () => {
    const s = sample();
    s.detail = { en: 'Ask {{lawyer_name}} about it.' };
    expect(() => validateEntry(s, 'x.json')).toThrow(/unknown placeholder \{\{lawyer_name\}\}/);
  });

  it('a file whose name does not match its id, or is not JSON, fails loudly with the file named', () => {
    const dir = mkdtempSync(join(tmpdir(), 'remedies-'));
    writeFileSync(join(dir, 'wrong-name.json'), JSON.stringify(sample()));
    expect(() => loadCatalogue(dir)).toThrow(/wrong-name\.json: file name does not match id/);
    writeFileSync(join(dir, 'wrong-name.json'), '{ not json');
    expect(() => loadCatalogue(dir)).toThrow(/wrong-name\.json: not valid JSON/);
  });

  it('two entries with one id cannot coexist', () => {
    const a = { remedy: sample(), file: 'a.json', hash: 'x' };
    const b = { remedy: sample(), file: 'b.json', hash: 'y' };
    expect(() => new Catalogue([a, b])).toThrow(/duplicate remedy id/);
  });
});

describe('versioning and audit (lock)', () => {
  it('the committed lock matches the content', () => {
    expect(verifyLock(catalogue, readLock())).toEqual([]);
  });

  it('the plain-JS lock script and the TypeScript hash agree', () => {
    const lock = readLock(LOCK_FILE);
    for (const entry of catalogue.all()) {
      expect(lock.entries[entry.remedy.id]?.hash, entry.file).toBe(entryHash(entry.remedy));
    }
    expect(buildLock(catalogue)).toEqual(lock);
  });

  it('a content change without a version bump is reported', () => {
    const lock = buildLock(catalogue);
    const changed = sample();
    changed.detail = { en: 'Reworded.' };
    const tampered = new Catalogue(
      catalogue
        .all()
        .map((e) =>
          e.remedy.id === changed.id ? { ...e, remedy: changed, hash: entryHash(changed) } : e,
        ),
    );
    expect(verifyLock(tampered, lock)).toEqual([
      `${changed.id}: content changed without a version bump (still ${changed.version})`,
    ]);
  });

  it('a bump is recorded in the lock, and a bump without a change is reported', () => {
    const lock = buildLock(catalogue);
    const next = sample().version + 1;
    const bumped = sample();
    bumped.version = next;
    bumped.detail = { en: 'Reworded.' };
    const withBump = new Catalogue(
      catalogue
        .all()
        .map((e) =>
          e.remedy.id === bumped.id ? { ...e, remedy: bumped, hash: entryHash(bumped) } : e,
        ),
    );
    expect(verifyLock(withBump, lock)[0]).toMatch(new RegExp(`changed to version ${next} — run`));

    const idle = sample();
    idle.version = next;
    const idleBump = new Catalogue(
      catalogue
        .all()
        .map((e) => (e.remedy.id === idle.id ? { ...e, remedy: idle, hash: entryHash(idle) } : e)),
    );
    expect(verifyLock(idleBump, lock)).toEqual([
      `${idle.id}: version bumped to ${next} without a content change`,
    ]);
  });

  it('a removed or added entry is reported', () => {
    const lock = buildLock(catalogue);
    const smaller = new Catalogue(
      catalogue.all().filter((e) => e.remedy.id !== 'cns-09-new-tracker'),
    );
    expect(verifyLock(smaller, lock)).toEqual([
      expect.stringMatching(/^cns-09-new-tracker: removed/),
    ]);
    const extra = sample();
    extra.id = 'cns-02-extra';
    const larger = new Catalogue([
      ...catalogue.all(),
      { remedy: extra, file: 'cns-02-extra.json', hash: entryHash(extra) },
    ]);
    expect(verifyLock(larger, lock)).toEqual([expect.stringMatching(/^cns-02-extra: new remedy/)]);
  });

  it('a finding pinned to a version the catalogue no longer holds gets nothing, not a newer one', () => {
    const current = catalogue.get('cns-02-gate-tags')!.remedy.version;
    expect(catalogue.get('cns-02-gate-tags', current)).toBeDefined();
    expect(catalogue.get('cns-02-gate-tags', current + 5)).toBeUndefined();
    expect(catalogue.get('nope')).toBeUndefined();
  });

  it('the hash ignores version and key order', () => {
    const a = sample();
    const b = { ...sample(), version: 9 };
    expect(entryHash(a)).toBe(entryHash(b as Remedy));
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"b":1}');
  });
});
