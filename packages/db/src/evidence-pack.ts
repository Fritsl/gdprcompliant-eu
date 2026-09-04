import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildEvidencePack,
  timelineModel,
  timelinePdf,
  type EvidencePack,
  type PackSignoff,
} from '@gc/artefacts';
import { sha256, type CaseEvent, type Locale } from '@gc/contracts';
import { DEFAULT_STORE, VERSION_FILE } from '@gc/findings';
import { CONTENT_DIR, LOCK_FILE_NAME } from '@gc/remedies';
import type { Connection } from './client.js';
import { loadCaseBundle, type CaseBundle } from './export.js';
import { withTenant } from './tenant.js';
import { appendCaseEvent } from './timeline.js';

// The evidence pack (G-04) from the database: the case as exportCase shapes it, the
// timeline PDF dated with the clock given, the sign-offs read off the timeline, and the
// versions of the reference material the case was assessed against. Building a pack
// changes nothing; the route that serves one records that it did, afterwards.

export interface EvidencePackOptions {
  readonly locale: Locale;
  // The moment the pack speaks for. Two packs with the same clock and the same case
  // are the same bytes.
  readonly at: Date;
}

const actorName = (a: CaseEvent['actor']): string =>
  a.kind === 'person' ? a.name : a.kind === 'agent' ? `assistant ${a.name}` : a.kind;

// What counts as a sign-off: ownership taken, a finding closed with a named person or
// an attestation behind it, a document published.
export function signoffsFrom(events: readonly CaseEvent[]): PackSignoff[] {
  const out: PackSignoff[] = [];
  for (const e of events) {
    if (e.type === 'case_claimed') {
      out.push({
        at: e.at,
        who: e.payload.email ?? e.payload.by ?? actorName(e.actor),
        what: `took ownership of the case (${e.payload.method})`,
      });
    } else if (e.type === 'finding_closed') {
      out.push({
        at: e.at,
        who: actorName(e.actor),
        what: `closed ${e.payload.findingId}, verified by ${e.payload.verifiedBy}`,
      });
    } else if (e.type === 'artefact_signed') {
      out.push({
        at: e.at,
        who: e.payload.by,
        what: `signed ${e.payload.kind} v${e.payload.version} (sha256 ${e.payload.hash.slice(0, 12)}…)`,
      });
    } else if (e.type === 'artefact_published') {
      out.push({ at: e.at, who: actorName(e.actor), what: `published ${e.payload.kind}` });
    } else if (e.type === 'export_produced') {
      out.push({
        at: e.at,
        who: actorName(e.actor),
        what: `exported the case (sha256 ${e.payload.sha256.slice(0, 12)}…)`,
      });
    }
  }
  return out;
}

export function corpusVersionsFrom(bundle: CaseBundle): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    out['remedy-catalogue-lock'] = sha256(readFileSync(join(CONTENT_DIR, LOCK_FILE_NAME), 'utf8'));
  } catch {
    out['remedy-catalogue-lock'] = 'unavailable';
  }
  try {
    const v = JSON.parse(readFileSync(join(DEFAULT_STORE, VERSION_FILE), 'utf8')) as Record<
      string,
      unknown
    >;
    out['cookie-database'] = String(v['version'] ?? v['date'] ?? JSON.stringify(v));
  } catch {
    out['cookie-database'] = 'unavailable';
  }
  const bindings = new Map<string, number>();
  for (const f of bundle.f) {
    const b = f.binding as { version?: number; guideId?: string } | null;
    if (b && typeof b.version === 'number')
      bindings.set(`${f.typeId}/${f.jurisdiction}`, b.version);
  }
  for (const [k, v] of [...bindings.entries()].sort()) out[`binding ${k}`] = String(v);
  const registries = new Set<string>();
  for (const v of bundle.v) {
    const p = v.provenance as { registryVersion?: string } | null;
    if (p?.registryVersion) registries.add(p.registryVersion);
  }
  for (const r of [...registries].sort()) out[`registry ${r.split('@')[0]}`] = r.split('@')[1] ?? r;
  return out;
}

export async function evidencePack(
  connection: Connection,
  tenantId: string,
  caseId: string,
  options: EvidencePackOptions,
): Promise<EvidencePack> {
  return withTenant(connection, tenantId, async (db) => {
    const all = await loadCaseBundle(db, caseId);
    const model = timelineModel(caseId, all.events, { locale: options.locale });
    const pdf = await timelinePdf(model, {
      title: 'Timeline',
      generatedAt: options.at,
      generatedLabel: 'Generated',
      pageLabel: (p, n) => `Page ${p} of ${n}`,
    });
    const { accessToken: _token, tenantId: _t, ...caseRow } = all.c;
    void _token;
    void _t;
    const strip = <T extends { tenantId: string }>(rows: readonly T[]) =>
      rows.map(({ tenantId: _x, ...rest }) => {
        void _x;
        return rest;
      });
    const bundle = {
      format: 'gdprcompliant.eu/evidence-pack',
      version: 1,
      generatedAt: options.at.toISOString(),
      case: caseRow,
      findings: strip(all.f),
      findingEvidence: strip(all.links),
      evidence: strip(all.e),
      answers: strip(all.a),
      vendors: strip(all.v),
      processingActivities: strip(all.p),
      timeline: all.events,
      signoffs: signoffsFrom(all.events),
      corpusVersions: corpusVersionsFrom(all),
    };
    return buildEvidencePack({
      caseId,
      domain: (all.c.company as { domain?: string }).domain ?? 'unknown',
      stage: all.c.stage,
      generatedAt: options.at,
      bundle,
      evidence: all.e.map((e) => ({
        id: e.id,
        kind: e.kind,
        hash: e.hash,
        body: e.body,
        caption: e.caption,
      })),
      timelinePdf: new Uint8Array(pdf),
      signoffs: bundle.signoffs,
      corpusVersions: bundle.corpusVersions,
      counts: {
        findings: all.f.length,
        evidence: all.e.length,
        answers: all.a.length,
        vendors: all.v.length,
        events: all.events.length,
      },
    });
  });
}

// The route that hands a pack out says so on the timeline, after the pack is built,
// so the pack never contains its own generation.
export async function recordPackGenerated(
  connection: Connection,
  tenantId: string,
  caseId: string,
  pack: Pick<EvidencePack, 'sha256'>,
  at: Date = new Date(),
): Promise<void> {
  await withTenant(connection, tenantId, (db) =>
    appendCaseEvent(db, {
      tenantId,
      caseId,
      at,
      actor: { kind: 'system' },
      type: 'artefact_generated',
      payload: { artefactId: `evidence-pack:${pack.sha256.slice(0, 16)}`, kind: 'evidence_pack' },
    }),
  );
}
