import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SUPPORTED_JURISDICTIONS, citationKey, type FindingTypeId } from '@gc/contracts';
import {
  DETECTORS,
  UnboundFindingType,
  UnsupportedJurisdiction,
  bindingCoverage,
  bindingFor,
  citationFromRow,
  expectedByFixtures,
  loadBindingTables,
  resolveBinding,
} from '@gc/findings';
import {
  documentChunks,
  loadCorpusDocuments,
  loadDecisions,
  resolveDecision,
  resolveInChunks,
} from '@gc/corpus';
import { loadCatalogue } from '@gc/remedies';
import { renderBindings } from '../../../scripts/bindings-doc.js';

// Jurisdiction bindings (I-02): a finding has one identity and per-jurisdiction bindings
// that are content; every promised type is bound everywhere the product speaks; every
// citation resolves for its jurisdiction; an unsupported jurisdiction fails explicitly;
// detector code names no article; the lawyer's document is generated from the content.

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const tables = loadBindingTables();
const chunks = loadCorpusDocuments().flatMap(documentChunks);
const decisions = loadDecisions();

function promisedTypes(): FindingTypeId[] {
  const ids = new Set<FindingTypeId>(DETECTORS.map((d) => d.findingTypeId));
  for (const id of expectedByFixtures().keys()) ids.add(id);
  const fixture = JSON.parse(
    readFileSync(join(ROOT, 'fixtures', 'companies', 'eksempelbutik.json'), 'utf8'),
  ) as { findings: { id: FindingTypeId }[] };
  for (const f of fixture.findings) ids.add(f.id);
  return [...ids].sort();
}

describe('the binding table is content, complete, and resolves', () => {
  it('has a table for every supported jurisdiction and nothing else', () => {
    expect([...tables.keys()].sort()).toEqual([...SUPPORTED_JURISDICTIONS].sort());
  });

  it('binds every finding type the product can raise, in every supported jurisdiction', () => {
    const types = promisedTypes();
    expect(types.length).toBeGreaterThan(20);
    expect(bindingCoverage(types)).toEqual([]);
    // And every remedy's finding type, so nothing in the catalogue is unbound either.
    const catalogueTypes = [
      ...new Set(
        loadCatalogue()
          .all()
          .map((e) => e.remedy.findingTypeId),
      ),
    ].filter((id) => id !== 'ANY-00');
    expect(bindingCoverage(catalogueTypes as FindingTypeId[])).toEqual([]);
  });

  it('every citation in every table resolves in the corpus for that jurisdiction', () => {
    for (const [jurisdiction, table] of tables) {
      for (const row of table.bindings) {
        for (const c of row.citations) {
          const citation = citationFromRow(c);
          const r =
            citation.kind === 'decision'
              ? resolveDecision(decisions, citation, jurisdiction)
              : resolveInChunks(chunks, citation, jurisdiction);
          expect(
            r.ok,
            `${jurisdiction} ${row.findingTypeId} ${citationKey(citation)}: ${!r.ok ? r.detail : ''}`,
          ).toBe(true);
        }
      }
    }
  });

  it("gives the same identity a different binding per jurisdiction, and never another country's authority", () => {
    const dk = bindingFor('CNS-02', 'DK');
    const de = bindingFor('CNS-02', 'DE');
    expect(dk.findingTypeId).toBe(de.findingTypeId);
    expect(dk.jurisdiction).toBe('DK');
    expect(de.jurisdiction).toBe('DE');
    expect(dk.authority.name).toBe('Datatilsynet');
    expect(de.authority.name).not.toBe('Datatilsynet');
    for (const [jurisdiction, table] of tables) {
      for (const row of table.bindings) {
        const b = bindingFor(row.findingTypeId, jurisdiction);
        expect(b.authority.name).toBe(table.authority.name);
        for (const c of b.citations) {
          if (c.jurisdiction !== undefined) expect(c.jurisdiction).toBe(jurisdiction);
        }
      }
    }
    // A national court's decision comes first in its own country.
    expect(bindingFor('VND-06', 'DE').citations[0]?.kind).toBe('decision');
    expect(bindingFor('VND-06', 'DK').citations[0]?.kind).toBe('provision');
  });
});

describe('an unsupported jurisdiction degrades explicitly', () => {
  it('never falls back to Danish or German law', () => {
    const r = resolveBinding('CNS-02', 'FR');
    expect(r).toEqual({
      ok: false,
      reason: 'unsupported_jurisdiction',
      jurisdiction: 'FR',
      supported: ['DE', 'DK'],
    });
    expect(() => bindingFor('CNS-02', 'FR')).toThrow(UnsupportedJurisdiction);
    expect(() => bindingFor('CNS-02', 'FR')).toThrow(/does not answer with another country's law/);
    expect(() => bindingFor('CNS-02', 'EU')).toThrow(UnsupportedJurisdiction);
    expect(() => bindingFor('XYZ-99', 'DK')).toThrow(UnboundFindingType);
    const unbound = resolveBinding('XYZ-99', 'DK');
    expect(!unbound.ok && unbound.reason).toBe('unbound_finding_type');
  });
});

describe('no article number in detector code', () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (['node_modules', 'dist', 'content'].includes(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.tsx?$/.test(entry)) out.push(full);
    }
    return out;
  }

  it('the scanner and the finding registry name no instrument, article or paragraph', () => {
    const files = [
      join(ROOT, 'packages', 'scanner', 'src'),
      join(ROOT, 'packages', 'findings', 'src'),
    ]
      .flatMap((d) => walk(d))
      .filter((f) => !f.endsWith('bindings.ts'));
    const offenders: string[] = [];
    const patterns = [
      /\b(?:Art(?:icle|ikel)?\.?|§)\s*\d+/,
      /['"`](?:GDPR|ePrivacy|DSGVO|BDSG|TDDDG|Databeskyttelsesloven)['"`]/,
      /\b(?:Datatilsynet|Landesbeauftragte)\b/,
    ];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const p of patterns) {
        const m = p.exec(text);
        if (m) offenders.push(`${relative(ROOT, f).split(sep).join('/')}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('the lawyer’s document', () => {
  it('docs/bindings.md is generated from the tables and is current', () => {
    const rendered = renderBindings(tables);
    expect(readFileSync(join(ROOT, 'docs', 'bindings.md'), 'utf8')).toBe(rendered);
    expect(rendered).toContain('| CNS-02 | ');
    expect(rendered).toContain('ePrivacy Art. 5(3)');
    expect(rendered).toMatch(/Not yet reviewed by a lawyer|Last reviewed by/);
  });
});
