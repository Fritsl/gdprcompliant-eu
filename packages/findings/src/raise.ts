import {
  FindingSchema,
  findingFingerprint,
  sha256,
  type EvidenceRef,
  type Finding,
  type FindingSubject,
  type FindingTypeId,
  type Jurisdiction,
  type SecurityObservation,
} from '@gc/contracts';
import type { Catalogue } from '@gc/remedies';
import { bindingFor } from './bindings.js';
import { DETECTORS } from './registry.js';

// Raising findings (I-02, T-08). A detector hands over an identity — the type, what it
// is about, the evidence — and nothing else. Here it becomes a finding for one
// jurisdiction: the binding from the table, the remedy from the catalogue, the severity
// and area from the registry. The same drafts raised for two jurisdictions give the same
// identities with different bindings; an unsupported jurisdiction throws.

export interface FindingDraft {
  readonly typeId: FindingTypeId;
  readonly subject?: FindingSubject;
  readonly evidence: readonly EvidenceRef[];
}

export interface RaiseContext {
  readonly tenantId: string;
  readonly caseId: string;
  readonly jurisdiction: Jurisdiction;
  readonly catalogue: Catalogue;
  readonly scanId?: string;
  readonly now?: () => Date;
}

export class UnregisteredFindingType extends Error {
  constructor(public readonly typeId: string) {
    super(
      `${typeId} is not a registered detector; add it to packages/findings/content/detectors.json`,
    );
    this.name = 'UnregisteredFindingType';
  }
}

export class NoRemedy extends Error {
  constructor(
    public readonly typeId: string,
    public readonly jurisdiction: string,
  ) {
    super(`${typeId} has no remedy in ${jurisdiction}; a finding without a remedy cannot exist`);
    this.name = 'NoRemedy';
  }
}

export const findingId = (caseId: string, fingerprint: string): string =>
  `f-${sha256(`${caseId}|${fingerprint}`).slice(0, 16)}`;

export function raiseFinding(draft: FindingDraft, ctx: RaiseContext): Finding {
  const detector = DETECTORS.find((d) => d.findingTypeId === draft.typeId);
  if (!detector) throw new UnregisteredFindingType(draft.typeId);
  const binding = bindingFor(draft.typeId, ctx.jurisdiction);
  const remedy = ctx.catalogue.forFinding(draft.typeId, ctx.jurisdiction)[0];
  if (!remedy) throw new NoRemedy(draft.typeId, ctx.jurisdiction);
  const at = (ctx.now ?? (() => new Date()))().toISOString();
  const fingerprint = findingFingerprint(draft.typeId, draft.subject);
  return FindingSchema.parse({
    id: findingId(ctx.caseId, fingerprint),
    tenantId: ctx.tenantId,
    caseId: ctx.caseId,
    ...(ctx.scanId ? { scanId: ctx.scanId } : {}),
    typeId: draft.typeId,
    fingerprint,
    jurisdiction: ctx.jurisdiction,
    binding,
    severity: detector.defaultSeverity,
    status: 'open',
    area: detector.area,
    ...(draft.subject ? { subject: draft.subject } : {}),
    evidence: draft.evidence,
    remedy: { remedyId: remedy.remedy.id, version: remedy.remedy.version },
    firstSeenAt: at,
    lastSeenAt: at,
  });
}

export const raiseFindings = (drafts: readonly FindingDraft[], ctx: RaiseContext): Finding[] =>
  drafts.map((d) => raiseFinding(d, ctx));

// What the security surface (S-12) hands over: one draft per failed check, about the host.
export function draftsFromSecurity(
  observations: readonly SecurityObservation[],
  host: string,
): FindingDraft[] {
  return observations
    .filter((o) => o.outcome === 'fail')
    .map((o) => ({ typeId: o.findingTypeId, subject: { host }, evidence: o.evidence }))
    .sort((a, b) => a.typeId.localeCompare(b.typeId));
}

// The identity of a finding: what stays the same whichever jurisdiction it is raised in.
export const findingIdentity = (f: Pick<Finding, 'typeId' | 'fingerprint'>): string =>
  `${f.typeId}|${f.fingerprint}`;
