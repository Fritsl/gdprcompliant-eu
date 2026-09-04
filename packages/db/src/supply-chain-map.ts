import { and, eq, inArray } from 'drizzle-orm';
import type { ProcessorInput, SubProcessorRow } from '@gc/artefacts';
import { CompanySchema, type Company, type Locale } from '@gc/contracts';
import type { Connection } from './client.js';
import { processorsOf, subProcessorsOf } from './documents.js';
import { graphOf, registerProjection } from './graph.js';
import { cases, evidence } from './schema.js';
import { withTenant } from './tenant.js';

// What the supply-chain map (D-08) is drawn from: the company, the processors the
// confirmed register names (with the evidence that placed each), the chain the walk
// wrote (D-07), and the evidence rows the nodes point at, so the page can show where
// each company on the map came from.

export interface MapEvidenceRow {
  readonly id: string;
  readonly kind: string;
  readonly caption?: string;
  readonly url?: string;
  readonly hash: string;
  readonly capturedAt: string;
}

export interface SupplyChainMapInput {
  readonly company: Company;
  readonly locale: Locale;
  readonly processors: readonly (ProcessorInput & { readonly evidenceId?: string })[];
  readonly subProcessors: readonly SubProcessorRow[];
  readonly evidence: readonly MapEvidenceRow[];
}

export async function supplyChainMapInput(
  connection: Connection,
  tenantId: string,
  caseId: string,
): Promise<SupplyChainMapInput> {
  return withTenant(connection, tenantId, async (db) => {
    const [row] = await db
      .select({ locale: cases.locale, company: cases.company })
      .from(cases)
      .where(eq(cases.id, caseId))
      .limit(1);
    if (!row) throw new Error(`no case ${caseId}`);
    const rows = await registerProjection(db, caseId);
    const graph = await graphOf(db, caseId);
    const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
    // A processor is placed by the evidence its vendor node carries; the first ref will do.
    const processors: (ProcessorInput & { readonly evidenceId?: string })[] = processorsOf(
      rows,
      graph,
      true,
    ).map((p) => {
      const first = nodes.get(p.nodeId)?.evidence[0]?.evidenceId;
      return first ? { ...p, evidenceId: first } : p;
    });
    const subProcessors = subProcessorsOf(graph);
    const ids = [
      ...new Set([
        ...processors.flatMap((p) => (p.evidenceId ? [p.evidenceId] : [])),
        ...subProcessors.map((s) => s.evidenceId),
      ]),
    ];
    const found =
      ids.length === 0
        ? []
        : await db
            .select()
            .from(evidence)
            .where(and(eq(evidence.caseId, caseId), inArray(evidence.id, ids)));
    return {
      company: CompanySchema.parse(row.company),
      locale: row.locale as Locale,
      processors,
      subProcessors,
      evidence: found.map((e) => {
        const source = e.observed as { url?: string } | null;
        return {
          id: e.id,
          kind: e.kind,
          ...(e.caption ? { caption: e.caption } : {}),
          ...(source?.url ? { url: source.url } : {}),
          hash: e.hash,
          capturedAt: e.capturedAt.toISOString(),
        };
      }),
    };
  });
}
