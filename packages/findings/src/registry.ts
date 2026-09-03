import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  FindingAreaSchema,
  FindingTypeIdSchema,
  SUPPORTED_JURISDICTIONS,
  type FindingTypeId,
  type Jurisdiction,
} from '@gc/contracts';
import type { Catalogue } from '@gc/remedies';
import detectorsJson from '../content/detectors.json' with { type: 'json' };

// The detectors the code can raise a finding for, as content, so a new detector is a
// registry entry that the completeness check (R-02) sees before its code is merged.
// The fixture estate's expectations count too: a finding a fixture expects is a finding
// the product has promised, and it needs a remedy in every supported jurisdiction.

export const DetectorSchema = z.object({
  findingTypeId: FindingTypeIdSchema,
  area: FindingAreaSchema,
  // Where it lives, e.g. "scanner/checks/security#hsts".
  detector: z.string().min(1),
});
export type Detector = z.infer<typeof DetectorSchema>;

export const DETECTORS: readonly Detector[] = z.array(DetectorSchema).parse(detectorsJson);

export const FIXTURE_SITES_DIR = fileURLToPath(
  new URL('../../../fixtures/sites/', import.meta.url),
);

// Finding types the fixture estate expects a scan to produce.
export function expectedByFixtures(dir: string = FIXTURE_SITES_DIR): Map<FindingTypeId, string[]> {
  const out = new Map<FindingTypeId, string[]>();
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const file = join(dir, name, 'expected.json');
    if (!existsSync(file)) continue;
    const expected = JSON.parse(readFileSync(file, 'utf8')) as { findings?: { must?: string[] } };
    for (const id of expected.findings?.must ?? []) {
      const parsed = FindingTypeIdSchema.safeParse(id);
      if (parsed.success) out.set(parsed.data, [...(out.get(parsed.data) ?? []), name]);
    }
  }
  return out;
}

export interface CompletenessGap {
  readonly findingTypeId: FindingTypeId;
  readonly jurisdiction: Jurisdiction;
  readonly promisedBy: readonly string[];
}

export interface Completeness {
  readonly findingTypes: readonly FindingTypeId[];
  readonly jurisdictions: readonly Jurisdiction[];
  readonly gaps: readonly CompletenessGap[];
}

// Every registered or promised finding type must resolve to at least one catalogue
// remedy in every supported jurisdiction. A gap here fails CI.
export function checkFindingCompleteness(
  catalogue: Catalogue,
  options: {
    detectors?: readonly Detector[];
    fixturesDir?: string;
    jurisdictions?: readonly Jurisdiction[];
  } = {},
): Completeness {
  const detectors = options.detectors ?? DETECTORS;
  const jurisdictions = options.jurisdictions ?? SUPPORTED_JURISDICTIONS;
  const promised = new Map<FindingTypeId, string[]>();
  for (const d of detectors)
    promised.set(d.findingTypeId, [...(promised.get(d.findingTypeId) ?? []), d.detector]);
  for (const [id, fixtures] of expectedByFixtures(options.fixturesDir)) {
    promised.set(id, [...(promised.get(id) ?? []), ...fixtures.map((f) => `fixture:${f}`)]);
  }
  const findingTypes = [...promised.keys()].sort();
  const gaps: CompletenessGap[] = [];
  for (const findingTypeId of findingTypes) {
    for (const jurisdiction of jurisdictions) {
      if (catalogue.forFinding(findingTypeId, jurisdiction).length === 0) {
        gaps.push({ findingTypeId, jurisdiction, promisedBy: promised.get(findingTypeId) ?? [] });
      }
    }
  }
  return { findingTypes, jurisdictions, gaps };
}
