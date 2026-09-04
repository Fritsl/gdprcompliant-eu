import type { FindingTypeId } from '@gc/contracts';
import { DETECTORS } from './registry.js';

// Which checks have to run again to re-verify a finding (C-05): the detector path in
// detectors.json names the module, and the module belongs to a family the scanner can
// run on its own. A finding whose detector is not a scanner module (a registry lookup,
// a model worker) has no family to re-run and is verified another way.

export const CHECK_FAMILIES = [
  'security',
  'forms',
  'replay',
  'policies',
  'consent',
  'recipients',
  'ct',
] as const;
export type CheckFamily = (typeof CHECK_FAMILIES)[number];

const FAMILY_OF_MODULE: Readonly<Record<string, CheckFamily>> = {
  'scanner/checks/security': 'security',
  'scanner/checks/forms': 'forms',
  'scanner/checks/replay': 'replay',
  'scanner/discovery/policies': 'policies',
  'scanner/checks/recipients': 'recipients',
  'scanner/consent/banner': 'consent',
  'scanner/passes/pass-bc': 'consent',
  'scanner/passes/differ': 'consent',
  'scanner/ct/enumerate': 'ct',
};

export function checkFamilyFor(typeId: FindingTypeId): CheckFamily | undefined {
  const detector = DETECTORS.find((d) => d.findingTypeId === typeId);
  if (!detector) return undefined;
  const module = detector.detector.split('#')[0] ?? '';
  return FAMILY_OF_MODULE[module];
}

// Every finding type a family can raise.
export function typesInFamily(family: CheckFamily): FindingTypeId[] {
  return DETECTORS.filter((d) => checkFamilyFor(d.findingTypeId) === family).map(
    (d) => d.findingTypeId,
  );
}
