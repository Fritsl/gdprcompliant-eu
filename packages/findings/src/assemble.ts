import {
  FindingSchema,
  canonicalJson,
  findingFingerprint,
  sha256,
  type ConsentFindingDraft,
  type CtEnumeration,
  type EvidenceRef,
  type Finding,
  type FindingStatus,
  type FindingSubject,
  type FindingTypeId,
  type FormObservation,
  type PolicyDiscovery,
  type ReplayObservation,
  type SecurityObservation,
  type Severity,
} from '@gc/contracts';
import { bindingFor } from './bindings.js';
import { NoRemedy, UnregisteredFindingType, findingId, type RaiseContext } from './raise.js';
import { DETECTORS } from './registry.js';
import { severityFor, type SeverityDecision } from './severity.js';

// Finding assembly (S-14). Every check hands over what it saw as a draft: the type, what
// it is about, the evidence it points at, and, where the check grades what it saw, a
// severity. Assembly turns the drafts into findings for one case in one jurisdiction —
// binding, remedy, severity from the table — in a fixed order, with ids that depend on
// the case and the identity alone. The same scan assembled twice is the same bytes; a
// draft without evidence or without a remedy is refused, not persisted quietly.

export interface AssemblyDraft {
  readonly typeId: FindingTypeId;
  readonly subject?: FindingSubject;
  readonly evidence: readonly EvidenceRef[];
  readonly observed?: Severity;
  readonly hosts?: readonly string[];
  readonly summary?: string;
}

export interface AssemblyInput {
  readonly security?: readonly SecurityObservation[];
  readonly forms?: readonly FormObservation[];
  readonly replay?: readonly ReplayObservation[];
  readonly policies?: PolicyDiscovery;
  readonly ct?: CtEnumeration;
  readonly consent?: readonly ConsentFindingDraft[];
  readonly drafts?: readonly AssemblyDraft[];
}

export interface AssemblyContext extends RaiseContext {
  // The scanned host; what a site-wide finding is about.
  readonly host: string;
  readonly sectorCode?: string;
  // Status of findings the case already has, by fingerprint, for the regression rule.
  readonly previous?: ReadonlyMap<string, FindingStatus>;
}

export interface AssembledFinding {
  readonly finding: Finding;
  readonly severity: SeverityDecision;
  readonly summary?: string;
}

export interface Assembly {
  readonly findings: readonly Finding[];
  readonly detail: readonly AssembledFinding[];
  // sha256 of the canonical findings: two identical scans give the same digest.
  readonly digest: string;
  // Drafts the same finding was raised from more than once, folded into one.
  readonly folded: number;
}

export class DraftWithoutEvidence extends Error {
  constructor(public readonly typeId: string) {
    super(`${typeId}: a finding without evidence cannot exist; the draft carries none`);
    this.name = 'DraftWithoutEvidence';
  }
}

const failed = <T extends { outcome: string }>(o: T): boolean => o.outcome === 'fail';

export function draftsFromChecks(input: AssemblyInput, host: string): AssemblyDraft[] {
  const out: AssemblyDraft[] = [];
  for (const o of input.security ?? []) {
    if (failed(o))
      out.push({
        typeId: o.findingTypeId,
        subject: { host },
        evidence: o.evidence,
        summary: o.summary,
      });
  }
  for (const o of input.forms ?? []) {
    if (failed(o)) {
      out.push({
        typeId: o.findingTypeId,
        subject: { host },
        evidence: o.evidence,
        observed: o.severity,
        summary: o.summary,
      });
    }
  }
  for (const o of input.replay ?? []) {
    if (failed(o)) {
      out.push({
        typeId: o.findingTypeId,
        subject: { host },
        evidence: o.evidence,
        observed: o.severity,
        summary: o.summary,
      });
    }
  }
  if (input.policies && failed(input.policies.observation)) {
    const o = input.policies.observation;
    out.push({
      typeId: o.findingTypeId,
      subject: { host },
      evidence: o.evidence,
      summary: o.summary,
    });
  }
  if (input.ct && failed(input.ct.observation)) {
    const o = input.ct.observation;
    out.push({
      typeId: o.findingTypeId,
      subject: { host },
      evidence: o.evidence,
      summary: o.summary,
    });
  }
  for (const d of input.consent ?? []) {
    out.push({
      typeId: d.typeId,
      subject: { host },
      evidence: d.evidence,
      hosts: d.hosts,
      summary: d.summary,
    });
  }
  out.push(...(input.drafts ?? []));
  return out;
}

export function assembleFindings(input: AssemblyInput, ctx: AssemblyContext): Assembly {
  const drafts = draftsFromChecks(input, ctx.host);
  const now = (ctx.now ?? (() => new Date()))().toISOString();

  // Fold drafts with the same identity: the evidence and the hosts of both, the higher
  // observed severity.
  const byFingerprint = new Map<string, AssemblyDraft>();
  let folded = 0;
  for (const d of drafts) {
    const fp = findingFingerprint(d.typeId, d.subject);
    const existing = byFingerprint.get(fp);
    if (!existing) {
      byFingerprint.set(fp, d);
      continue;
    }
    folded += 1;
    const evidence = [...existing.evidence];
    for (const e of d.evidence)
      if (!evidence.some((x) => x.evidenceId === e.evidenceId)) evidence.push(e);
    const hosts = [...new Set([...(existing.hosts ?? []), ...(d.hosts ?? [])])].sort();
    const observed =
      existing.observed && d.observed
        ? severityFor(existing.observed, { area: 'Consent', observed: d.observed }).severity
        : (existing.observed ?? d.observed);
    byFingerprint.set(fp, {
      ...existing,
      evidence,
      ...(hosts.length > 0 ? { hosts } : {}),
      ...(observed ? { observed } : {}),
      ...(existing.summary ? {} : d.summary ? { summary: d.summary } : {}),
    });
  }

  const detail: AssembledFinding[] = [];
  for (const [fingerprint, d] of [...byFingerprint.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (d.evidence.length === 0) throw new DraftWithoutEvidence(d.typeId);
    const detector = DETECTORS.find((x) => x.findingTypeId === d.typeId);
    if (!detector) throw new UnregisteredFindingType(d.typeId);
    const binding = bindingFor(d.typeId, ctx.jurisdiction);
    const remedy = ctx.catalogue.forFinding(d.typeId, ctx.jurisdiction)[0];
    if (!remedy) throw new NoRemedy(d.typeId, ctx.jurisdiction);
    const previousStatus = ctx.previous?.get(fingerprint);
    const severity = severityFor(detector.defaultSeverity, {
      area: detector.area,
      ...(d.observed ? { observed: d.observed } : {}),
      ...(d.hosts ? { hosts: d.hosts.length } : {}),
      ...(ctx.sectorCode ? { sectorCode: ctx.sectorCode } : {}),
      ...(previousStatus ? { previousStatus } : {}),
    });
    const evidence = [...d.evidence].sort((a, b) => a.evidenceId.localeCompare(b.evidenceId));
    const finding = FindingSchema.parse({
      id: findingId(ctx.caseId, fingerprint),
      tenantId: ctx.tenantId,
      caseId: ctx.caseId,
      ...(ctx.scanId ? { scanId: ctx.scanId } : {}),
      typeId: d.typeId,
      fingerprint,
      jurisdiction: ctx.jurisdiction,
      binding,
      severity: severity.severity,
      status: 'open',
      area: detector.area,
      ...(d.subject ? { subject: d.subject } : {}),
      evidence,
      remedy: { remedyId: remedy.remedy.id, version: remedy.remedy.version },
      firstSeenAt: now,
      lastSeenAt: now,
    });
    detail.push({ finding, severity, ...(d.summary ? { summary: d.summary } : {}) });
  }
  const findings = detail.map((x) => x.finding);
  return { findings, detail, digest: sha256(canonicalJson(findings)), folded };
}
