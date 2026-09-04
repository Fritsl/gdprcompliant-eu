import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FINDING_AREAS, REMEDY_KINDS } from '@gc/contracts';
import { DETECTORS, checkFamilyFor, loadBindingTables } from '@gc/findings';
import { loadCatalogue, loadGuides } from '@gc/remedies';
import { loadFixtureSites } from '@gc/scanner';
import { renderFindingsDoc } from '../../scripts/findings-doc.js';

// The launch finding types (S-15): every type in the registry is complete. A detector
// with a family, a fixture that must raise it and one that must not, a remedy of a
// declared kind in every jurisdiction, a binding that names its guide, a guide in
// English and Danish that a non-specialist can follow, and a line in docs/findings.md.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const catalogue = loadCatalogue();
const guides = loadGuides();
const tables = loadBindingTables();
const sites = loadFixtureSites();
const jurisdictions = [...tables.keys()].sort();
// The certificate-log family cannot be shown by a fixture site; its own suite proves it
// against recorded log answers (S-13).
const PROVED_BY_CASSETTE = new Set(['EXP-01']);

describe('the launch finding types', () => {
  it('are at least twenty, and cover consent, recipients, transfers, notice, collection, observation and security', () => {
    expect(DETECTORS.length).toBeGreaterThanOrEqual(20);
    const areas = new Set(DETECTORS.map((d) => d.area));
    for (const area of [
      'Consent',
      'Recipients',
      'Transfers',
      'Notice',
      'Collection',
      'Observation',
      'Security',
    ] as const) {
      expect(areas.has(area), area).toBe(true);
    }
    for (const area of areas) expect(FINDING_AREAS).toContain(area);
  });

  it.each(DETECTORS.map((d) => [d.findingTypeId, d] as const))('%s is complete', (_, d) => {
    const id = d.findingTypeId;
    // A positive and a negative fixture, or a cassette-backed suite for the one family
    // a site cannot show.
    const positive = sites.filter((s) => s.expected.findings.must.includes(id));
    const negative = sites.filter((s) => s.expected.findings.mustNot.includes(id));
    // A type raised from what the case holds (the drift check, G-05) has no page to
    // show it; its own suite proves it against the estate.
    const fromCaseData = d.detector.startsWith('db/');
    if (!PROVED_BY_CASSETTE.has(id) && !fromCaseData) {
      expect(positive.length, `${id}: no fixture must raise it`).toBeGreaterThan(0);
      expect(negative.length, `${id}: no fixture must not raise it`).toBeGreaterThan(0);
      expect(checkFamilyFor(id), `${id}: no family to re-run`).toBeDefined();
    }
    // A remedy of a declared kind in every jurisdiction.
    for (const j of jurisdictions) {
      const remedies = catalogue.forFinding(id, j as never);
      expect(remedies.length, `${id} has no remedy in ${j}`).toBeGreaterThan(0);
      for (const r of remedies) expect(REMEDY_KINDS).toContain(r.remedy.kind);
      const binding = tables.get(j as never)?.bindings.find((b) => b.findingTypeId === id);
      expect(binding, `${id} is unbound in ${j}`).toBeDefined();
      expect(binding!.citations.length).toBeGreaterThan(0);
      // The binding names the guide, and the guide exists for this type.
      expect(guides.byId(binding!.guideId)?.findingTypeId, `${id}: guide ${binding!.guideId}`).toBe(
        id,
      );
    }
    // The guide reads as a page: a title, what is wrong, why, at least two steps, how to confirm.
    const guide = guides.forFinding(id)!;
    expect(guide, `${id} has no guide`).toBeDefined();
    for (const locale of ['en', 'da'] as const) {
      for (const [name, text] of [
        ['title', guide.title],
        ['wrong', guide.wrong],
        ['why', guide.why],
        ['confirm', guide.confirm],
        ...guide.steps.map((s, i) => [`step ${i + 1}`, s] as const),
      ] as const) {
        expect(text[locale], `${id} guide ${name} in ${locale}`).toBeTruthy();
        expect(text[locale]!.length, `${id} guide ${name} in ${locale}`).toBeGreaterThan(20);
      }
      expect(guide.title[locale]!.length).toBeLessThan(90);
    }
    expect(guide.steps.length).toBeGreaterThanOrEqual(2);
    if (guide.remedyId)
      expect(catalogue.get(guide.remedyId), `${id}: guide names ${guide.remedyId}`).toBeDefined();
  });

  it('every guide is in English and Danish in full, and belongs to a registered type', () => {
    expect(guides.completeLocales()).toEqual(expect.arrayContaining(['en', 'da']));
    const registered = new Set(DETECTORS.map((d) => d.findingTypeId));
    for (const g of guides.guides) expect(registered.has(g.findingTypeId), g.id).toBe(true);
  });

  it('docs/findings.md is generated from the registry and is current', () => {
    const rendered = renderFindingsDoc();
    expect(readFileSync(join(ROOT, 'docs', 'findings.md'), 'utf8')).toBe(rendered);
    for (const d of DETECTORS) expect(rendered).toContain(`## ${d.findingTypeId} · `);
  });
});
