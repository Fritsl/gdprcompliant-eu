import { citationKey, type Citation, type FindingArea, type Locale } from '@gc/contracts';
import {
  caseCompany,
  caseTimeline,
  findingsWithEvidence,
  listMembers,
  withTenant,
  type Connection,
} from '@gc/db';
import { DETECTORS, checkFamilyFor, roleFor } from '@gc/findings';
import { localise } from '@gc/i18n';
import type { Catalogue } from '@gc/remedies';
import type { ReportArticle, ReportDecision, ReportInput } from '@gc/artefacts';
import type { CorpusChunk, DecisionsRegistry } from '@gc/contracts';
import { documentChunks, loadCorpusDocuments, loadDecisions } from './content.js';
import { resolveDecision, resolveInChunks } from './resolve.js';

// Assembling the status report (V-01) from the case as it stands: findings with their
// remedies and desks, what the scanner could not determine, which areas it can see at
// all, and every provision the findings rest on, resolved in the corpus. A citation that
// does not resolve stops the report; a document that quotes law must quote the corpus.

export class ReportCitationUnresolved extends Error {
  constructor(
    public readonly citation: Citation,
    public readonly detail: string,
  ) {
    super(`${citationKey(citation)} does not resolve: ${detail}`);
    this.name = 'ReportCitationUnresolved';
  }
}

export interface AssembleReportOptions {
  readonly catalogue: Catalogue;
  readonly locale: Locale;
  readonly caseUrl: string;
  readonly now: Date;
  readonly chunks?: readonly CorpusChunk[];
  readonly decisions?: DecisionsRegistry;
}

let defaultChunks: CorpusChunk[] | undefined;
const corpusChunks = (): CorpusChunk[] =>
  (defaultChunks ??= loadCorpusDocuments().flatMap((d) => documentChunks(d)));

// Areas the scanner checks from outside: any detector in the area that a check family runs.
export const scannerAreas = (): FindingArea[] => [
  ...new Set(
    DETECTORS.filter((d) => checkFamilyFor(d.findingTypeId) !== undefined).map((d) => d.area),
  ),
];

const fillDomain = (text: string, domain: string) => text.replaceAll('{{domain}}', domain);

export async function assembleReport(
  connection: Connection,
  tenantId: string,
  caseId: string,
  options: AssembleReportOptions,
): Promise<ReportInput> {
  const company = await caseCompany(connection, tenantId, caseId);
  if (!company) throw new Error(`no case ${caseId}`);
  const domain = company.domain;
  const rows = await findingsWithEvidence(connection, tenantId, caseId);
  const members = await listMembers(connection, tenantId, caseId, {
    baseUrl: options.caseUrl,
    locale: options.locale,
    now: () => options.now,
  });
  const events = await withTenant(connection, tenantId, (db) => caseTimeline(db, caseId));
  const chunks = options.chunks ?? corpusChunks();
  const registry = options.decisions ?? loadDecisions();

  const ownerFor = new Map<string, string>();
  for (const m of members) {
    if ((m.status === 'joined' || m.status === 'finished') && !ownerFor.has(m.role))
      ownerFor.set(m.role, m.email);
  }

  const articles = new Map<string, ReportArticle>();
  const decisions = new Map<string, ReportDecision>();
  const findings = rows.map(({ finding }) => {
    const entry = options.catalogue.get(finding.remedyId, finding.remedyVersion);
    const remedy = entry?.remedy;
    const binding = finding.binding as { citations?: Citation[] } | null;
    const citations = Array.isArray(binding?.citations) ? binding.citations : [];
    const jurisdiction = finding.jurisdiction as Parameters<typeof resolveInChunks>[2];
    for (const c of citations) {
      const key = citationKey(c);
      if (c.kind === 'provision') {
        if (articles.has(key)) continue;
        const r = resolveInChunks(chunks, c, jurisdiction);
        if (!r.ok) throw new ReportCitationUnresolved(c, r.detail);
        if (!('chunk' in r)) throw new ReportCitationUnresolved(c, 'resolved to no paragraph');
        articles.set(key, {
          key,
          reference: `${c.instrument} ${c.ref}`,
          text: r.chunk.text,
          sourceUrl: r.chunk.source.url,
          corpusVersion: r.chunk.corpusVersion,
        });
      } else if (c.kind === 'decision') {
        if (decisions.has(key)) continue;
        const r = resolveDecision(registry, c, jurisdiction);
        if (!r.ok) throw new ReportCitationUnresolved(c, r.detail);
        if (!('decision' in r)) throw new ReportCitationUnresolved(c, 'resolved to no decision');
        decisions.set(key, {
          key,
          reference: `${c.body} ${c.reference}`,
          title: r.decision.title,
        });
      }
    }
    const role = roleFor({ typeId: finding.typeId, area: finding.area as FindingArea });
    const owner = ownerFor.get(role);
    return {
      typeId: finding.typeId,
      area: finding.area as FindingArea,
      severity: finding.severity as ReportInput['findings'][number]['severity'],
      status: finding.status as ReportInput['findings'][number]['status'],
      title: fillDomain(
        remedy ? localise(remedy.title, options.locale).value : finding.remedyId,
        domain,
      ),
      effort: remedy ? localise(remedy.effort.label, options.locale).value : '',
      ...(remedy?.effort.minutes !== undefined ? { minutes: remedy.effort.minutes } : {}),
      role,
      ...(owner ? { owner } : {}),
      ...(finding.closedAt ? { closedAt: finding.closedAt.toISOString() } : {}),
      citations,
    };
  });

  const undetermined = events
    .filter((e) => e.type === 'check_undetermined')
    .map((e) => {
      const p = e.payload as { typeId: string; reason: string };
      const detector = DETECTORS.find((d) => d.findingTypeId === p.typeId);
      return {
        typeId: p.typeId,
        area: (detector?.area ?? 'Recipients') as FindingArea,
        reason: p.reason,
      };
    })
    // A finding since raised or fixed in that area settles the question; only a check
    // with nothing else to say stays undetermined.
    .filter((u) => !findings.some((f) => f.typeId === u.typeId));

  return {
    caseId,
    domain,
    ...(company.legalName ? { legalName: company.legalName } : {}),
    caseUrl: options.caseUrl,
    generatedAt: options.now.toISOString(),
    findings,
    undetermined,
    coveredAreas: scannerAreas(),
    scanned: events.some((e) => e.type === 'scan_completed'),
    articles: [...articles.values()],
    decisions: [...decisions.values()],
  };
}
